package ssh

import (
	"context"
	"elka-desktop/backend/internal/apperror"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/crypto/ssh"
)

type SSHEmitter interface {
	EmitData(sessionID string, data []byte)
	EmitClosed(sessionID string)
	EmitMetrics(sessionID string, metrics ServerMetrics)
	EmitSFTPProgress(sessionID, direction, name, remotePath string, transferred, total int64)
}

type SSHConnectionConfig struct {
	ID   string `json:"id"`
	Host string `json:"host"`
	Port int    `json:"port"`
	// Attempt names one dial of one session. A reconnect reuses the session ID, and the teardown of
	// the previous dial can reach the service after the new one has already answered, so this is what
	// tells them apart. See SshService.Disconnect.
	Attempt              string              `json:"attempt,omitempty"`
	Username             string              `json:"username"`
	Password             string              `json:"password,omitempty"`
	PrivateKey           string              `json:"privateKey,omitempty"`
	PrivateKeyPassphrase string              `json:"privateKeyPassphrase,omitempty"`
	JumpHost             *SSHJumpHostConfig  `json:"jumpHost,omitempty"`
	JumpHosts            []SSHJumpHostConfig `json:"jumpHosts,omitempty"`
	PortForwards         []SSHPortForward    `json:"portForwards,omitempty"`
}

type SSHJumpHostConfig struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	Password             string `json:"password,omitempty"`
	PrivateKey           string `json:"privateKey,omitempty"`
	PrivateKeyPassphrase string `json:"privateKeyPassphrase,omitempty"`
}

type SSHPortForward struct {
	Mode          string `json:"mode"`
	ListenAddress string `json:"listenAddress"`
	ListenPort    int    `json:"listenPort"`
	TargetAddress string `json:"targetAddress"`
	TargetPort    int    `json:"targetPort"`
}

type SFTPEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Mode    string `json:"mode"`
}

type SFTPDirectory struct {
	Path    string      `json:"path"`
	Entries []SFTPEntry `json:"entries"`
}

type SSHPortForwardMode string

const (
	SSHPortForwardLocal  SSHPortForwardMode = "local"
	SSHPortForwardRemote SSHPortForwardMode = "remote"
)

type activeSession struct {
	client      *ssh.Client
	jumpClients []*ssh.Client
	session     *ssh.Session
	stdin       io.WriteCloser
	forwarders  []io.Closer
	// attempt — какой именно дозвон это соединение. Переподключение пользуется тем же ID сессии,
	// поэтому различать соединения приходится здесь, а не по ID.
	attempt string
	// metricsChannel непустой только пока вкладка с этой сессией на экране.
	metricsChannel *ssh.Session
	// config переживает сессию ради отдельного соединения под SFTP. В нём остаются креды, но они и
	// так лежат во фронтендовом сторе, а второе подключение без них не поднять.
	config *SSHConnectionConfig
	// sftpMu защищает sftp-клиент: операции идут по очереди, а его подъём и закрытие не должны
	// наезжать друг на друга.
	sftpMu sync.Mutex
	// sftp непустой, пока подсистема жива. sftpConn и sftpJumps — её отдельное соединение.
	sftp      *sftp.Client
	sftpConn  *ssh.Client
	sftpJumps []*ssh.Client
	// keepAliveStop останавливает фоновые пинги, которые не дают серверу, NAT и межсетевому
	// экрану закрыть простаивающее соединение.
	keepAliveStop func()
}

type SshService struct {
	emitter  SSHEmitter
	app      *application.App
	mu       sync.RWMutex
	sessions map[string]*activeSession
}

// TODO: configurable timeout?
const timeout = 15 * time.Second

// keepAliveInterval держит сессию живой, пока приложение открыто. Без пингов сервер с
// ClientAliveInterval, NAT или межсетевой экран закрывают простаивающее соединение, и вкладка
// пропадает раньше, чем пользователь успевает к ней вернуться. Тридцать секунд — типичный
// интервал OpenSSH и заведомо меньше любого часового простоя.
const keepAliveInterval = 30 * time.Second

const batchRatePerSecond = 60

const (
	sftpProgressInterval = 150 * time.Millisecond
	// sftpUploadConcurrency is the number of SFTP WRITE requests kept in flight for one file. The
	// protocol allows at most 64, but the benefit flattens out earlier while the load on the server
	// keeps growing, so 32 is a compromise between throughput and politeness.
	sftpUploadConcurrency = 32
)

func NewSshService(emitter SSHEmitter, app *application.App) *SshService {
	return &SshService{
		emitter:  emitter,
		app:      app,
		sessions: make(map[string]*activeSession),
	}
}

func (s *SshService) Connect(config *SSHConnectionConfig) error {
	client, jumpClients, err := connectSSH(config)
	if err != nil {
		// The login is part of the failure: a server refuses a wrong user exactly the way it refuses
		// a wrong password, and the message from the handshake cannot tell the two apart.
		message := fmt.Sprintf("failed to connect to %s as %q", net.JoinHostPort(config.Host, strconv.Itoa(config.Port)), config.Username)

		var authFailure *targetAuthError
		if errors.As(err, &authFailure) {
			return apperror.SSHAuthenticationFailed(message, authFailure.err)
		}
		return apperror.SSHConnectionFailed(message, err)
	}
	forwarders := make([]io.Closer, 0, len(config.PortForwards))
	for _, forwardConfig := range config.PortForwards {
		forwarder, forwardErr := startPortForward(client, forwardConfig)
		if forwardErr != nil {
			closeForwarders(forwarders)
			_ = client.Close()
			closeJumpClients(jumpClients)
			return apperror.SSHConnectionFailed("failed to start port forwarding", forwardErr)
		}
		forwarders = append(forwarders, forwarder)
	}

	session, err := client.NewSession()
	if err != nil {
		closeForwarders(forwarders)
		_ = client.Close()
		closeJumpClients(jumpClients)
		return apperror.SSHConnectionFailed("failed to create session", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		closeForwarders(forwarders)
		_ = client.Close()
		closeJumpClients(jumpClients)
		return err
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		closeForwarders(forwarders)
		_ = client.Close()
		closeJumpClients(jumpClients)
		return err
	}

	session.Stderr = session.Stdout

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200, // baud rate
		ssh.TTY_OP_OSPEED: 115200,
	}

	// 24x80 is just the default
	if err = session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		_ = session.Close()
		closeForwarders(forwarders)
		_ = client.Close()
		closeJumpClients(jumpClients)
		return apperror.SSHConnectionFailed("failed to request PTY", err)
	}

	if err = session.Shell(); err != nil {
		_ = session.Close()
		closeForwarders(forwarders)
		_ = client.Close()
		closeJumpClients(jumpClients)
		return apperror.SSHConnectionFailed("failed to start shell", err)
	}

	s.mu.Lock()
	// A session ID is reused by every reconnect of the same tab, so whatever is registered under it is
	// the previous dial and nothing else will ever close it. It goes here rather than into the void:
	// left behind it kept its shell running on the server and its reader goroutine alive, and its
	// eventual exit was reported as if it were the session the user is looking at.
	previous := s.sessions[config.ID]
	currentSession := &activeSession{
		client:        client,
		jumpClients:   jumpClients,
		session:       session,
		stdin:         stdin,
		forwarders:    forwarders,
		attempt:       config.Attempt,
		config:        config,
		keepAliveStop: startKeepAlive(client),
	}
	s.sessions[config.ID] = currentSession
	s.mu.Unlock()
	closeActiveSession(previous)

	go s.streamOutput(config.ID, stdout, currentSession)

	return nil
}

/**
 * targetAuthError marks a refusal by the target host itself.
 *
 * A jump hop that fails to log in is a configuration problem the user has to fix in the host form,
 * while a target that refuses the login can still be reached by typing the password in, so the two
 * are kept apart for as long as the error travels back to the interface.
 */
type targetAuthError struct {
	err error
}

func (e *targetAuthError) Error() string { return e.err.Error() }

func (e *targetAuthError) Unwrap() error { return e.err }

// x/crypto has no sentinel for a rejected login and builds the message by hand when the server
// leaves the client with nothing it is willing to answer with.
func isAuthenticationFailure(err error) bool {
	return err != nil && strings.Contains(err.Error(), "unable to authenticate")
}

func connectSSH(config *SSHConnectionConfig) (*ssh.Client, []*ssh.Client, error) {
	clientConfig, err := newClientConfig(config.Username, config.Password, config.PrivateKey, config.PrivateKeyPassphrase)
	if err != nil {
		return nil, nil, apperror.DecryptionFailed(err)
	}
	targetAddress := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	hops := config.JumpHosts
	if len(hops) == 0 && config.JumpHost != nil {
		hops = []SSHJumpHostConfig{*config.JumpHost}
	}
	if len(hops) == 0 {
		client, err := ssh.Dial("tcp", targetAddress, clientConfig)
		if isAuthenticationFailure(err) {
			return nil, nil, &targetAuthError{err: err}
		}
		return client, nil, err
	}

	jumpClients := make([]*ssh.Client, 0, len(hops))
	var routeClient *ssh.Client
	for index, jump := range hops {
		if jump.Host == "" || jump.Port < 1 || jump.Port > 65535 {
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("invalid jump host address at step %d", index+1)
		}
		jumpAddress := net.JoinHostPort(jump.Host, strconv.Itoa(jump.Port))
		jumpConfig, configErr := newClientConfig(jump.Username, jump.Password, jump.PrivateKey, jump.PrivateKeyPassphrase)
		if configErr != nil {
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("jump host %s at step %d: %w", jumpAddress, index+1, configErr)
		}
		if routeClient == nil {
			routeClient, err = ssh.Dial("tcp", jumpAddress, jumpConfig)
			if err != nil {
				closeJumpClients(jumpClients)
				return nil, nil, fmt.Errorf("jump host %s: %w", jumpAddress, err)
			}
			jumpClients = append(jumpClients, routeClient)
			continue
		}

		connection, dialErr := dialThroughTunnel(routeClient, jumpAddress, timeout)
		if dialErr != nil {
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("tunnel to jump host %s: %w", jumpAddress, dialErr)
		}
		client, handshakeErr := handshakeThroughTunnel(connection, jumpAddress, jumpConfig, timeout)
		if handshakeErr != nil {
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("authenticate to jump host %s: %w", jumpAddress, handshakeErr)
		}
		routeClient = client
		jumpClients = append(jumpClients, routeClient)
	}

	connection, err := dialThroughTunnel(routeClient, targetAddress, timeout)
	if err != nil {
		closeJumpClients(jumpClients)
		return nil, nil, fmt.Errorf("tunnel to target %s: %w", targetAddress, err)
	}
	targetClient, handshakeErr := handshakeThroughTunnel(connection, targetAddress, clientConfig, timeout)
	if handshakeErr != nil {
		closeJumpClients(jumpClients)
		if isAuthenticationFailure(handshakeErr) {
			return nil, nil, &targetAuthError{err: handshakeErr}
		}
		return nil, nil, handshakeErr
	}
	return targetClient, jumpClients, nil
}

// dialThroughTunnel открывает соединение через уже поднятый туннель под тем же сроком, что и прямой
// набор.
//
// У ssh.Dial время берётся из ClientConfig, а Dial по туннелю своего не знает: цель, которая приняла
// соединение от бастиона, но так и не ответила, держала бы подключение открытым навсегда, и вкладка
// висела бы на «Подключение…» без единого шанса дойти до конца.
func dialThroughTunnel(route *ssh.Client, address string, limit time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()

	return route.DialContext(ctx, "tcp", address)
}

// connectionTimeoutError — срок, на который не уложился дозвон.
type connectionTimeoutError struct {
	address string
	limit   time.Duration
}

func (e *connectionTimeoutError) Error() string {
	return fmt.Sprintf("%s did not answer within %s", e.address, e.limit)
}

func (e *connectionTimeoutError) Timeout() bool   { return true }
func (e *connectionTimeoutError) Temporary() bool { return true }

// handshakeThroughTunnel завершает хендшейк под тем же сроком, что и прямой набор.
//
// Дедлайн на соединение поставить нельзя: пересланный канал direct-tcpip его не поддерживает вовсе
// и отвечает на SetDeadline ошибкой. Поэтому хендшейк идёт в отдельной горутине, а по истечении срока
// соединение закрывается — это выбивает согласование из ожидания.
func handshakeThroughTunnel(connection net.Conn, address string, config *ssh.ClientConfig, limit time.Duration) (*ssh.Client, error) {
	type handshake struct {
		connection ssh.Conn
		channels   <-chan ssh.NewChannel
		requests   <-chan *ssh.Request
		err        error
	}

	settled := make(chan handshake, 1)
	go func() {
		clientConnection, channels, requests, err := ssh.NewClientConn(connection, address, config)
		settled <- handshake{connection: clientConnection, channels: channels, requests: requests, err: err}
	}()

	select {
	case result := <-settled:
		if result.err != nil {
			_ = connection.Close()
			return nil, result.err
		}
		return ssh.NewClient(result.connection, result.channels, result.requests), nil

	case <-time.After(limit):
		_ = connection.Close()
		// Дожидаемся конца хендшейка, чтобы он не остался висеть поверх закрытого соединения.
		<-settled
		return nil, &connectionTimeoutError{address: address, limit: limit}
	}
}

func closeJumpClients(clients []*ssh.Client) {
	for index := len(clients) - 1; index >= 0; index-- {
		_ = clients[index].Close()
	}
}

func newClientConfig(username, password, privateKey, passphrase string) (*ssh.ClientConfig, error) {
	var authMethods []ssh.AuthMethod
	if privateKey != "" {
		signer, err := parsePrivateKey(privateKey, passphrase)
		if err != nil {
			return nil, err
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if password != "" {
		authMethods = append(authMethods, ssh.Password(password))
		// Многие серверы (sshd с PasswordAuthentication no и KbdInteractiveAuthentication yes,
		// PAM, свежие Windows/OpenSSH-образы) объявляют только keyboard-interactive. x/crypto
		// пробует лишь те методы из Auth, что перечислил сервер, поэтому без этой строки клиент
		// уходил с "attempted methods [none]", хотя пароль был верный. На первый же вопрос с
		// паролем отвечаем тем же паролем, на остальные (логин, код и т.п.) — пустой строкой.
		authMethods = append(authMethods, ssh.KeyboardInteractiveChallenge(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for index, question := range questions {
				if strings.Contains(strings.ToLower(question), "password") || strings.Contains(strings.ToLower(question), "парол") {
					answers[index] = password
				}
			}
			return answers, nil
		}))
	}
	if len(authMethods) == 0 {
		return nil, fmt.Errorf("no password and no private key to authenticate with")
	}
	return &ssh.ClientConfig{
		User: username,
		Auth: authMethods,
		// TODO proper host key handling
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         timeout,
	}, nil
}

func startPortForward(client *ssh.Client, config SSHPortForward) (io.Closer, error) {
	if config.ListenPort < 1 || config.ListenPort > 65535 || config.TargetPort < 1 || config.TargetPort > 65535 {
		return nil, fmt.Errorf("port numbers must be between 1 and 65535")
	}
	if config.TargetAddress == "" {
		return nil, fmt.Errorf("target address is required")
	}
	if config.ListenAddress == "" {
		config.ListenAddress = "127.0.0.1"
	}
	listenAddress := net.JoinHostPort(config.ListenAddress, strconv.Itoa(config.ListenPort))
	targetAddress := net.JoinHostPort(config.TargetAddress, strconv.Itoa(config.TargetPort))

	var listener net.Listener
	var err error
	switch config.Mode {
	case "local":
		listener, err = net.Listen("tcp", listenAddress)
	case "remote":
		listener, err = client.Listen("tcp", listenAddress)
	default:
		return nil, fmt.Errorf("unsupported port forwarding mode %q", config.Mode)
	}
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", listenAddress, err)
	}

	go acceptForwards(listener, func() (net.Conn, error) {
		if config.Mode == "local" {
			return client.Dial("tcp", targetAddress)
		}
		return net.DialTimeout("tcp", targetAddress, timeout)
	})
	return listener, nil
}

func acceptForwards(listener net.Listener, dialTarget func() (net.Conn, error)) {
	for {
		incoming, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			outgoing, err := dialTarget()
			if err != nil {
				_ = incoming.Close()
				return
			}
			bridgeConnections(incoming, outgoing)
		}()
	}
}

func bridgeConnections(left, right net.Conn) {
	copyDone := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(right, left)
		copyDone <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(left, right)
		copyDone <- struct{}{}
	}()
	<-copyDone
	_ = left.Close()
	_ = right.Close()
	<-copyDone
}

func closeForwarders(forwarders []io.Closer) {
	for _, forwarder := range forwarders {
		_ = forwarder.Close()
	}
}

func parsePrivateKey(privateKey, passphrase string) (ssh.Signer, error) {
	signer, err := ssh.ParsePrivateKey([]byte(privateKey))
	if err == nil || passphrase == "" {
		return signer, err
	}

	var passphraseMissing *ssh.PassphraseMissingError
	if !errors.As(err, &passphraseMissing) {
		return nil, err
	}
	return ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
}

// Input writes data to SSH stdin
func (s *SshService) Input(sessionID string, data string) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	_, err := active.stdin.Write([]byte(data))
	return err
}

func (s *SshService) Resize(sessionID string, rows, cols int) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()

	if !exists {
		return apperror.SSHSessionNotFound()
	}

	return active.session.WindowChange(rows, cols)
}

func (s *SshService) ListSFTPDirectory(sessionID, directory string) (SFTPDirectory, error) {
	var result SFTPDirectory
	err := s.withSFTP(sessionID, func(client *sftp.Client) error {
		resolved, err := resolveSFTPPath(client, directory)
		if err != nil {
			return fmt.Errorf("resolve remote directory: %w", err)
		}
		files, err := client.ReadDir(resolved)
		if err != nil {
			return fmt.Errorf("read remote directory %s: %w", resolved, err)
		}

		entries := make([]SFTPEntry, 0, len(files))
		for _, file := range files {
			if file.Name() == "." || file.Name() == ".." {
				continue
			}
			entries = append(entries, SFTPEntry{
				Name:    file.Name(),
				Path:    path.Join(resolved, file.Name()),
				IsDir:   file.IsDir(),
				Size:    file.Size(),
				ModTime: file.ModTime().Unix(),
				Mode:    file.Mode().String(),
			})
		}
		result = SFTPDirectory{Path: resolved, Entries: entries}
		return nil
	})
	if err != nil {
		return SFTPDirectory{}, err
	}
	return result, nil
}

func (s *SshService) DownloadSFTPFile(ctx context.Context, sessionID, remotePath, suggestedFilename, dialogTitle string) (bool, error) {
	var downloaded bool
	err := s.withSFTP(sessionID, func(client *sftp.Client) error {
		var err error
		downloaded, err = s.downloadSFTPFile(ctx, client, sessionID, remotePath, suggestedFilename, dialogTitle)
		return err
	})
	if err != nil {
		return false, err
	}
	return downloaded, nil
}

func (s *SshService) downloadSFTPFile(ctx context.Context, client *sftp.Client, sessionID, remotePath, suggestedFilename, dialogTitle string) (bool, error) {
	remotePath, err := resolveSFTPPath(client, remotePath)
	if err != nil {
		return false, fmt.Errorf("resolve remote file: %w", err)
	}
	if s.app == nil {
		return false, fmt.Errorf("file save dialog is unavailable")
	}
	if strings.TrimSpace(suggestedFilename) == "" {
		suggestedFilename = path.Base(remotePath)
	}
	if strings.TrimSpace(dialogTitle) == "" {
		dialogTitle = "Save remote file"
	}
	localPath, err := s.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:                dialogTitle,
		Filename:             suggestedFilename,
		CanCreateDirectories: true,
	}).PromptForSingleSelection()
	if err != nil {
		return false, fmt.Errorf("choose a local destination: %w", err)
	}
	if localPath == "" {
		return false, nil
	}

	remoteFile, err := client.Open(remotePath)
	if err != nil {
		return false, fmt.Errorf("open remote file %s: %w", remotePath, err)
	}
	defer remoteFile.Close()
	localFile, err := os.OpenFile(localPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0666)
	if err != nil {
		return false, fmt.Errorf("create local file %s: %w", localPath, err)
	}
	var total int64
	if info, statErr := remoteFile.Stat(); statErr == nil {
		total = info.Size()
	}
	if err = s.copySFTPWithProgress(ctx, sessionID, "download", path.Base(remotePath), remotePath, remoteFile, localFile, total); err != nil {
		_ = localFile.Close()
		if errors.Is(err, context.Canceled) {
			// A cancelled download leaves a truncated file behind, and a truncated file that looks
			// complete is worse than no file at all.
			_ = os.Remove(localPath)
			return false, err
		}
		return false, fmt.Errorf("download remote file %s: %w", remotePath, err)
	}
	if err = localFile.Close(); err != nil {
		return false, fmt.Errorf("close local file %s: %w", localPath, err)
	}
	return true, nil
}

// UploadSFTPFiles asks the user for local files and streams them to remoteDirectory. The files are
// read in Go instead of being sent from the frontend: a file picked in the webview would have to
// cross the IPC bridge as base64, which both costs several copies of the file in memory and runs
// into WebView2's request body limit on Windows.
func (s *SshService) UploadSFTPFiles(ctx context.Context, sessionID, remoteDirectory, dialogTitle string) (int, error) {
	if s.app == nil {
		return 0, fmt.Errorf("file open dialog is unavailable")
	}
	if strings.TrimSpace(dialogTitle) == "" {
		dialogTitle = "Upload files"
	}
	localPaths, err := s.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title:                   dialogTitle,
		CanChooseFiles:          true,
		AllowsMultipleSelection: true,
	}).PromptForMultipleSelection()
	if err != nil {
		return 0, fmt.Errorf("choose local files: %w", err)
	}
	if len(localPaths) == 0 {
		return 0, nil
	}

	uploaded := 0
	err = s.withSFTP(sessionID, func(client *sftp.Client) error {
		for _, localPath := range localPaths {
			if err := s.uploadSFTPLocalFile(ctx, client, sessionID, remoteDirectory, localPath); err != nil {
				return err
			}
			uploaded++
		}
		return nil
	})
	return uploaded, err
}

func (s *SshService) uploadSFTPLocalFile(ctx context.Context, client *sftp.Client, sessionID, remoteDirectory, localPath string) error {
	info, err := os.Stat(localPath)
	if err != nil {
		return fmt.Errorf("read local file %s: %w", localPath, err)
	}
	if info.IsDir() {
		return fmt.Errorf("read local file %s: it is a directory", localPath)
	}
	localFile, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open local file %s: %w", localPath, err)
	}
	defer localFile.Close()

	remotePath, err := resolveSFTPPath(client, path.Join(remoteDirectory, filepath.Base(localPath)))
	if err != nil {
		return fmt.Errorf("resolve remote file: %w", err)
	}
	// Upload into a sibling temp file and publish it only after every write has been acknowledged.
	// A dropped connection then leaves the previous version of the file intact instead of a
	// truncated one. Replacing the file also replaces its mode, so remember the old one.
	existingMode, preserveMode := os.FileMode(0), false
	if existing, statErr := client.Stat(remotePath); statErr == nil {
		existingMode, preserveMode = existing.Mode().Perm(), true
	}
	tempPath := remotePath + ".temp-upload"
	file, err := client.Create(tempPath)
	if err != nil {
		return fmt.Errorf("create remote file %s: %w", remotePath, err)
	}
	if err = ctx.Err(); err != nil {
		_ = file.Close()
		_ = client.Remove(tempPath)
		return err
	}

	s.emitter.EmitSFTPProgress(sessionID, "upload", path.Base(remotePath), remotePath, 0, info.Size())
	reader := &sftpProgressReader{
		ctx:        ctx,
		source:     localFile,
		emitter:    s.emitter,
		sessionID:  sessionID,
		direction:  "upload",
		name:       path.Base(remotePath),
		remotePath: remotePath,
		total:      info.Size(),
		lastReport: time.Now(),
	}
	written, err := file.ReadFromWithConcurrency(reader, sftpUploadConcurrency)
	if err != nil {
		_ = file.Close()
		_ = client.Remove(tempPath)
		if errors.Is(err, context.Canceled) {
			return err
		}
		return fmt.Errorf("write remote file %s: %w", remotePath, err)
	}
	if err = file.Close(); err != nil {
		_ = client.Remove(tempPath)
		return fmt.Errorf("close remote file %s: %w", remotePath, err)
	}
	s.emitter.EmitSFTPProgress(sessionID, "upload", path.Base(remotePath), remotePath, written, info.Size())
	// Cancellation can arrive after the last chunk was read but before the rename.
	if err = ctx.Err(); err != nil {
		_ = client.Remove(tempPath)
		return err
	}
	if preserveMode {
		// Best effort: some chrooted SFTP accounts may write but not chmod.
		_ = client.Chmod(tempPath, existingMode)
	}
	if err = replaceRemoteFile(client, tempPath, remotePath); err != nil {
		_ = client.Remove(tempPath)
		return fmt.Errorf("replace remote file %s: %w", remotePath, err)
	}
	return nil
}

// replaceRemoteFile publishes a fully written temp file. posix-rename@openssh.com replaces the
// destination atomically; other servers fall back to remove+rename, like Tabby does.
func replaceRemoteFile(client *sftp.Client, tempPath, remotePath string) error {
	if err := client.PosixRename(tempPath, remotePath); err == nil {
		return nil
	}
	if err := client.Remove(remotePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return client.Rename(tempPath, remotePath)
}

// sftpProgressReader reports bytes as they are read from the local file. ReadFromWithConcurrency
// calls Read from a single goroutine, so no locking is needed here.
type sftpProgressReader struct {
	ctx         context.Context
	source      io.Reader
	emitter     SSHEmitter
	sessionID   string
	direction   string
	name        string
	remotePath  string
	total       int64
	transferred int64
	lastReport  time.Time
}

func (r *sftpProgressReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	read, readErr := r.source.Read(buffer)
	if read > 0 {
		r.transferred += int64(read)
		if time.Since(r.lastReport) >= sftpProgressInterval {
			r.lastReport = time.Now()
			r.emitter.EmitSFTPProgress(r.sessionID, r.direction, r.name, r.remotePath, r.transferred, r.total)
		}
	}
	return read, readErr
}

// copySFTPWithProgress moves the bytes itself instead of leaning on io.Copy, because pkg/sftp provides
// WriteTo and ReadFrom fast paths that would read or write around any counting wrapper, and the
// frontend only ever repaints on an emitted event, so one event per buffer would be wasted work.
func (s *SshService) copySFTPWithProgress(ctx context.Context, sessionID, direction, name, remotePath string, source io.Reader, target io.Writer, total int64) error {
	buffer := make([]byte, 128*1024)
	var transferred int64
	lastReport := time.Now()
	s.emitter.EmitSFTPProgress(sessionID, direction, name, remotePath, transferred, total)

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		read, readErr := source.Read(buffer)
		if read > 0 {
			if _, err := target.Write(buffer[:read]); err != nil {
				return err
			}
			transferred += int64(read)
			if time.Since(lastReport) >= sftpProgressInterval {
				lastReport = time.Now()
				// The caller has already been told the transfer is over once the context is done,
				// so a last event here would put a progress bar back on screen for good.
				if err := ctx.Err(); err != nil {
					return err
				}
				s.emitter.EmitSFTPProgress(sessionID, direction, name, remotePath, transferred, total)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

// withSFTP выполняет операцию на общем sftp-клиенте сессии.
//
// Подсистема живёт на отдельном SSH-соединении, а не на том, где идёт терминал. На том соединении
// слоты сессий уже заняты шеллом и сбором метрик, и сервер с жёстким MaxSessions (часто 1 или 2)
// просто не даёт открыть ещё один канал сессии для SFTP. У отдельного соединения свой лимит, поэтому
// SFTP получает первый слот независимо от настроек сервера. Так же делают Termius и Tabby.
//
// Клиент один на сессию, а не на операцию: новый канал на каждый каталог означал бы новый хендшейк и
// гонку за слот, который сервер освобождает не сразу. Ошибка операции закрывает клиент, чтобы
// следующая операция началась с чистого соединения.
func (s *SshService) withSFTP(sessionID string, operation func(*sftp.Client) error) error {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()
	if !exists || active.client == nil {
		return apperror.SSHSessionNotFound()
	}

	active.sftpMu.Lock()
	defer active.sftpMu.Unlock()

	client, err := s.openSFTPClient(active)
	if err != nil {
		return err
	}
	if err = operation(client); err != nil {
		closeSFTPLocked(active)
		return err
	}
	return nil
}

// openSFTPClient поднимает подсистему на отдельном соединении при первом обращении. Вызывается под
// sftpMu.
func (s *SshService) openSFTPClient(active *activeSession) (*sftp.Client, error) {
	if active.sftp != nil {
		return active.sftp, nil
	}
	if active.config == nil {
		return nil, fmt.Errorf("start SFTP subsystem: no connection settings for a second connection")
	}

	connection, jumps, err := connectSSH(active.config)
	if err != nil {
		return nil, fmt.Errorf("start SFTP subsystem: open a second connection: %w", err)
	}
	client, err := sftp.NewClient(connection)
	if err != nil {
		_ = connection.Close()
		closeJumpClients(jumps)
		return nil, fmt.Errorf("start SFTP subsystem: %w", err)
	}
	active.sftp, active.sftpConn, active.sftpJumps = client, connection, jumps
	return client, nil
}

// closeSFTPConnection закрывает подсистему и её отдельное соединение, если они были подняты.
// Основное соединение закрывает вызывающий.
func closeSFTPConnection(active *activeSession) {
	active.sftpMu.Lock()
	defer active.sftpMu.Unlock()
	closeSFTPLocked(active)
}

func closeSFTPLocked(active *activeSession) {
	if active.sftp != nil {
		_ = active.sftp.Close()
		active.sftp = nil
	}
	if active.sftpConn != nil {
		_ = active.sftpConn.Close()
		closeJumpClients(active.sftpJumps)
		active.sftpConn = nil
		active.sftpJumps = nil
	}
}

func resolveSFTPPath(client *sftp.Client, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" || requested == "~" || strings.HasPrefix(requested, "~/") {
		home, err := client.Getwd()
		if err != nil || home == "" {
			home = "."
		}
		if requested == "" || requested == "~" {
			requested = home
		} else {
			requested = path.Join(home, strings.TrimPrefix(requested, "~/"))
		}
	}
	requested = path.Clean(requested)
	if path.IsAbs(requested) {
		return requested, nil
	}
	workingDirectory, err := client.Getwd()
	if err != nil || workingDirectory == "" {
		return requested, nil
	}
	return path.Join(workingDirectory, requested), nil
}

// Disconnect tears the session down on request from the UI. It deliberately does not emit the closed
// event: that event means the session ended on its own (see cleanupSession) and the UI reacts to it
// by marking the tab, which would close a tab the user asked to reconnect instead.
//
// attempt names the dial that is asking. The two calls travel over the same HTTP bridge as everything
// else and are therefore served in whatever order they arrive: a teardown issued for the dial before a
// reconnect can reach the service after the new dial has already answered, and closing whatever sits
// under that ID then kills the session the user is watching. An empty attempt means "whatever it is",
// which is what a caller that never dialed — closing a tab, emptying the vault — has to say.
func (s *SshService) Disconnect(sessionID string, attempt string) {
	s.mu.Lock()
	active, exists := s.sessions[sessionID]
	if exists && attempt != "" && active.attempt != attempt {
		exists = false
	}
	if exists {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()

	if exists {
		closeActiveSession(active)
	}
}

// startKeepAlive шлёт серверу пустые глобальные запросы, пока соединение живо. Ответ не
// запрашивается намеренно: не все серверы отвечают на keepalive@openssh.com, а ждать ответа
// значило бы рвать исправное соединение. Пакет сам по себе продлевает и SSH-сессию, и запись в
// NAT, поэтому вкладка переживает многочасовой простой.
func startKeepAlive(client *ssh.Client) func() {
	done := make(chan struct{})
	var once sync.Once

	go func() {
		ticker := time.NewTicker(keepAliveInterval)
		defer ticker.Stop()

		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if _, _, err := client.SendRequest("keepalive@openssh.com", false, nil); err != nil {
					// Запись не прошла — соединения больше нет. Закрываем его, чтобы читатель
					// вывода узнал об этом и пометил вкладку, а не висел в ожидании.
					_ = client.Close()
					return
				}
			}
		}
	}()

	return func() {
		once.Do(func() { close(done) })
	}
}

// closeActiveSession закрывает соединение целиком. Сессии, которой уже нет, закрывать нечего.
func closeActiveSession(active *activeSession) {
	if active == nil {
		return
	}
	if active.keepAliveStop != nil {
		active.keepAliveStop()
		active.keepAliveStop = nil
	}
	if active.session != nil {
		_ = active.session.Close()
	}
	// Канал сбора метрик открыт на том же соединении: если он останется висеть, сервер будет крутить
	// цикл сбора до конца сессии.
	if active.metricsChannel != nil {
		_ = active.metricsChannel.Close()
	}
	closeForwarders(active.forwarders)
	closeSFTPConnection(active)
	if active.client != nil {
		_ = active.client.Close()
	}
	closeJumpClients(active.jumpClients)
}

func (s *SshService) streamOutput(sessionID string, stdout io.Reader, current *activeSession) {
	buf := make([]byte, 32*1024)
	dataChan := make(chan []byte)

	go readOutput(stdout, buf, dataChan)

	batchDelay := time.Second / time.Duration(batchRatePerSecond)
	ticker := time.NewTicker(batchDelay)
	defer ticker.Stop()

	batchSize := 128 * 1024
	batch := make([]byte, 0, batchSize)

	for {
		select {
		case chunk, ok := <-dataChan:
			if !ok {
				if len(batch) > 0 {
					s.emitter.EmitData(sessionID, batch)
				}
				s.cleanupSession(sessionID, current)
				return
			}

			batch = append(batch, chunk...)

			if len(batch) >= batchSize {
				s.emitter.EmitData(sessionID, batch)
				batch = batch[:0]
			}

		case <-ticker.C:
			if len(batch) > 0 {
				s.emitter.EmitData(sessionID, batch)
				batch = batch[:0]
			}
		}
	}
}

func readOutput(stdout io.Reader, buf []byte, dataChan chan []byte) {
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			dataChan <- chunk
		}
		if err != nil {
			close(dataChan)
			return
		}
	}
}

func (s *SshService) cleanupSession(sessionID string, current *activeSession) {
	s.mu.Lock()
	active, exists := s.sessions[sessionID]
	// The map has to still point at this dial: a reconnect registers a new one under the same ID, and
	// reporting the exit of the old one then would mark a live tab as gone.
	owned := exists && active == current
	if owned {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()

	if !owned {
		return
	}
	// The event goes out before the teardown, not after it. Closing an SFTP transfer in flight waits
	// for the transfer to finish, and the interface was left looking at a live tab for as long as a
	// large download took, showing nothing about a session that was already gone.
	s.emitter.EmitClosed(sessionID)
	closeActiveSession(current)
}
