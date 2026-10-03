package ssh

import (
	"bytes"
	"elka-desktop/backend/internal/apperror"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
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
}

type SSHConnectionConfig struct {
	ID                   string              `json:"id"`
	Host                 string              `json:"host"`
	Port                 int                 `json:"port"`
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
}

type SshService struct {
	emitter  SSHEmitter
	app      *application.App
	mu       sync.RWMutex
	sessions map[string]*activeSession
}

// TODO: configurable timeout?
const timeout = 15 * time.Second

const batchRatePerSecond = 60

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
		return apperror.SSHConnectionFailed(fmt.Sprintf("failed to connect to %s", net.JoinHostPort(config.Host, strconv.Itoa(config.Port))), err)
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
	currentSession := &activeSession{
		client:      client,
		jumpClients: jumpClients,
		session:     session,
		stdin:       stdin,
		forwarders:  forwarders,
	}
	s.sessions[config.ID] = currentSession
	s.mu.Unlock()

	go s.streamOutput(config.ID, stdout, currentSession)

	return nil
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
		return client, nil, err
	}

	jumpClients := make([]*ssh.Client, 0, len(hops))
	var routeClient *ssh.Client
	for index, jump := range hops {
		if jump.Host == "" || jump.Port < 1 || jump.Port > 65535 {
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("invalid jump host address at step %d", index+1)
		}
		jumpConfig, configErr := newClientConfig(jump.Username, jump.Password, jump.PrivateKey, jump.PrivateKeyPassphrase)
		if configErr != nil {
			closeJumpClients(jumpClients)
			return nil, nil, apperror.DecryptionFailed(configErr)
		}
		jumpAddress := net.JoinHostPort(jump.Host, strconv.Itoa(jump.Port))
		if routeClient == nil {
			routeClient, err = ssh.Dial("tcp", jumpAddress, jumpConfig)
			if err != nil {
				closeJumpClients(jumpClients)
				return nil, nil, fmt.Errorf("jump host %s: %w", jumpAddress, err)
			}
			jumpClients = append(jumpClients, routeClient)
			continue
		}

		connection, dialErr := routeClient.Dial("tcp", jumpAddress)
		if dialErr != nil {
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("tunnel to jump host %s: %w", jumpAddress, dialErr)
		}
		clientConnection, channels, requests, handshakeErr := ssh.NewClientConn(connection, jumpAddress, jumpConfig)
		if handshakeErr != nil {
			_ = connection.Close()
			closeJumpClients(jumpClients)
			return nil, nil, fmt.Errorf("authenticate to jump host %s: %w", jumpAddress, handshakeErr)
		}
		routeClient = ssh.NewClient(clientConnection, channels, requests)
		jumpClients = append(jumpClients, routeClient)
	}

	connection, err := routeClient.Dial("tcp", targetAddress)
	if err != nil {
		closeJumpClients(jumpClients)
		return nil, nil, fmt.Errorf("tunnel to target %s: %w", targetAddress, err)
	}
	clientConnection, channels, requests, err := ssh.NewClientConn(connection, targetAddress, clientConfig)
	if err != nil {
		_ = connection.Close()
		closeJumpClients(jumpClients)
		return nil, nil, err
	}
	return ssh.NewClient(clientConnection, channels, requests), jumpClients, nil
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
	client, err := s.newSFTPClient(sessionID)
	if err != nil {
		return SFTPDirectory{}, err
	}
	defer client.Close()

	directory, err = resolveSFTPPath(client, directory)
	if err != nil {
		return SFTPDirectory{}, fmt.Errorf("resolve remote directory: %w", err)
	}
	files, err := client.ReadDir(directory)
	if err != nil {
		return SFTPDirectory{}, fmt.Errorf("read remote directory %s: %w", directory, err)
	}

	entries := make([]SFTPEntry, 0, len(files))
	for _, file := range files {
		if file.Name() == "." || file.Name() == ".." {
			continue
		}
		entries = append(entries, SFTPEntry{
			Name:    file.Name(),
			Path:    path.Join(directory, file.Name()),
			IsDir:   file.IsDir(),
			Size:    file.Size(),
			ModTime: file.ModTime().Unix(),
			Mode:    file.Mode().String(),
		})
	}
	return SFTPDirectory{Path: directory, Entries: entries}, nil
}

func (s *SshService) DownloadSFTPFile(sessionID, remotePath, suggestedFilename, dialogTitle string) (bool, error) {
	client, err := s.newSFTPClient(sessionID)
	if err != nil {
		return false, err
	}
	defer client.Close()

	remotePath, err = resolveSFTPPath(client, remotePath)
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
	if _, err = io.Copy(localFile, remoteFile); err != nil {
		_ = localFile.Close()
		return false, fmt.Errorf("download remote file %s: %w", remotePath, err)
	}
	if err = localFile.Close(); err != nil {
		return false, fmt.Errorf("close local file %s: %w", localPath, err)
	}
	return true, nil
}

func (s *SshService) UploadSFTPFile(sessionID, remotePath string, data []byte) error {
	client, err := s.newSFTPClient(sessionID)
	if err != nil {
		return err
	}
	defer client.Close()

	remotePath, err = resolveSFTPPath(client, remotePath)
	if err != nil {
		return fmt.Errorf("resolve remote file: %w", err)
	}
	file, err := client.Create(remotePath)
	if err != nil {
		return fmt.Errorf("create remote file %s: %w", remotePath, err)
	}
	if _, err = io.Copy(file, bytes.NewReader(data)); err != nil {
		_ = file.Close()
		return fmt.Errorf("write remote file %s: %w", remotePath, err)
	}
	if err = file.Close(); err != nil {
		return fmt.Errorf("close remote file %s: %w", remotePath, err)
	}
	return nil
}

func (s *SshService) newSFTPClient(sessionID string) (*sftp.Client, error) {
	s.mu.RLock()
	active, exists := s.sessions[sessionID]
	s.mu.RUnlock()
	if !exists || active.client == nil {
		return nil, apperror.SSHSessionNotFound()
	}
	client, err := sftp.NewClient(active.client)
	if err != nil {
		return nil, fmt.Errorf("start SFTP subsystem: %w", err)
	}
	return client, nil
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
// by dropping the tab, which would close a tab the user asked to reconnect instead.
func (s *SshService) Disconnect(sessionID string) {
	s.mu.Lock()
	active, exists := s.sessions[sessionID]
	if exists {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()

	if exists {
		closeForwarders(active.forwarders)
		_ = active.session.Close()
		_ = active.client.Close()
		closeJumpClients(active.jumpClients)
	}
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
	if exists && active == current {
		delete(s.sessions, sessionID)
		s.mu.Unlock()

		if current.session != nil {
			_ = current.session.Close()
		}
		closeForwarders(current.forwarders)
		if current.client != nil {
			_ = current.client.Close()
		}
		closeJumpClients(current.jumpClients)
		s.emitter.EmitClosed(sessionID)
	} else {
		s.mu.Unlock()
	}
}
