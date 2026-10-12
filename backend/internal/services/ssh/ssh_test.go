package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/pkg/sftp"
	gossh "golang.org/x/crypto/ssh"
)

func TestParsePrivateKeyWithPassphrase(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	const passphrase = "correct horse battery staple"
	block, err := gossh.MarshalPrivateKeyWithPassphrase(privateKey, "test", []byte(passphrase))
	if err != nil {
		t.Fatal(err)
	}
	encodedKey := string(pem.EncodeToMemory(block))

	if _, err = parsePrivateKey(encodedKey, ""); err == nil {
		t.Fatal("expected encrypted key parsing to require a passphrase")
	}
	if _, err = parsePrivateKey(encodedKey, "wrong passphrase"); err == nil {
		t.Fatal("expected an incorrect passphrase to fail")
	}
	if _, err = parsePrivateKey(encodedKey, passphrase); err != nil {
		t.Fatalf("expected the correct passphrase to parse the key: %v", err)
	}
}

func TestStartPortForwardRejectsInvalidConfiguration(t *testing.T) {
	_, err := startPortForward(nil, SSHPortForward{
		Mode:          "local",
		ListenPort:    0,
		TargetAddress: "127.0.0.1",
		TargetPort:    22,
	})
	if err == nil {
		t.Fatal("expected invalid port to be rejected")
	}

	_, err = startPortForward(nil, SSHPortForward{
		Mode:          "dynamic",
		ListenAddress: "127.0.0.1",
		ListenPort:    8080,
		TargetAddress: "127.0.0.1",
		TargetPort:    22,
	})
	if err == nil {
		t.Fatal("expected unsupported forwarding mode to be rejected")
	}
}

const testSFTPPassword = "hunter2"

// fakeSSHServer держит sessionsPerConnection сессий на соединение, как sshd с MaxSessions. Всё, что
// сверх лимита, отклоняется тем же отказом, что шлёт настоящий OpenSSH, когда session_new() не
// нашёл свободного слота: SSH_OPEN_CONNECT_FAILED с текстом "open failed".
type fakeSSHServer struct {
	listener              net.Listener
	config                *gossh.ServerConfig
	sessionsPerConnection int

	mu                      sync.Mutex
	connections             int
	rejectedSessionChannels int
}

func newFakeSSHServer(t *testing.T, sessionsPerConnection int) *fakeSSHServer {
	t.Helper()

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := gossh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	server := &fakeSSHServer{
		sessionsPerConnection: sessionsPerConnection,
		config: &gossh.ServerConfig{
			PasswordCallback: func(gossh.ConnMetadata, []byte) (*gossh.Permissions, error) {
				return nil, nil
			},
		},
	}
	server.config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server.listener = listener
	go server.serve()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

// connectionConfig возвращает настройки подключения к этому серверу.
func (f *fakeSSHServer) connectionConfig() *SSHConnectionConfig {
	address, ok := f.listener.Addr().(*net.TCPAddr)
	if !ok {
		return nil
	}
	return &SSHConnectionConfig{
		Host:     address.IP.String(),
		Port:     address.Port,
		Username: "tester",
		Password: testSFTPPassword,
	}
}

// stats возвращает число принятых соединений и число отклонённых каналов сессии.
func (f *fakeSSHServer) stats() (connections, rejected int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connections, f.rejectedSessionChannels
}

func (f *fakeSSHServer) serve() {
	for {
		connection, err := f.listener.Accept()
		if err != nil {
			return
		}
		go f.handleConnection(connection)
	}
}

func (f *fakeSSHServer) handleConnection(connection net.Conn) {
	serverConn, channels, requests, err := gossh.NewServerConn(connection, f.config)
	if err != nil {
		_ = connection.Close()
		return
	}
	defer serverConn.Close()
	go gossh.DiscardRequests(requests)

	f.mu.Lock()
	f.connections++
	f.mu.Unlock()

	opened := 0
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(gossh.UnknownChannelType, "only session channels are supported")
			continue
		}

		f.mu.Lock()
		allowed := opened < f.sessionsPerConnection
		if allowed {
			opened++
		} else {
			f.rejectedSessionChannels++
		}
		f.mu.Unlock()

		if !allowed {
			_ = newChannel.Reject(gossh.ConnectionFailed, "open failed")
			continue
		}

		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go serveFakeSession(channel, channelRequests)
	}
}

func serveFakeSession(channel gossh.Channel, requests <-chan *gossh.Request) {
	defer channel.Close()
	for request := range requests {
		switch request.Type {
		case "subsystem":
			if !replyWithSFTPVersion(channel, request) {
				return
			}
		case "shell", "exec", "pty-req":
			if request.WantReply {
				_ = request.Reply(true, nil)
			}
		default:
			if request.WantReply {
				_ = request.Reply(false, nil)
			}
		}
	}
}

// replyWithSFTPVersion подтверждает запрос подсистемы и обменивается версией протокола. Дальше
// клиенту достаточно успешного NewClient, поэтому настоящий протокол SFTP тут не нужен.
func replyWithSFTPVersion(channel gossh.Channel, request *gossh.Request) bool {
	var payload struct{ Subsystem string }
	if err := gossh.Unmarshal(request.Payload, &payload); err != nil || payload.Subsystem != "sftp" {
		if request.WantReply {
			_ = request.Reply(false, nil)
		}
		return false
	}
	if request.WantReply {
		if err := request.Reply(true, nil); err != nil {
			return false
		}
	}

	var length [4]byte
	if _, err := io.ReadFull(channel, length[:]); err != nil {
		return false
	}
	initial := make([]byte, binary.BigEndian.Uint32(length[:]))
	if _, err := io.ReadFull(channel, initial); err != nil {
		return false
	}

	// SSH_FXP_VERSION: длина, тип, версия протокола 3. Длина в SFTP не считает саму себя, поэтому
	// в кадре девять байт, а в поле длины — пять.
	version := make([]byte, 9)
	binary.BigEndian.PutUint32(version[0:4], 5)
	version[4] = 2
	binary.BigEndian.PutUint32(version[5:9], 3)
	if _, err := channel.Write(version); err != nil {
		return false
	}

	// Настоящий sftp-server выходит, увидев EOF от клиента, и закрывает канал. Без этого Close()
	// на клиенте ждёт ответа, которого не будет.
	_, _ = io.Copy(io.Discard, channel)
	return false
}

// newTestService поднимает сервис поверх одной готовой сессии, как это делает Connect.
func newTestService(t *testing.T, config *SSHConnectionConfig) *SshService {
	t.Helper()

	service := NewSshService(&noopSSHEmitter{}, nil)
	client, _, err := connectSSH(config)
	if err != nil {
		t.Fatalf("connect to the test server: %v", err)
	}
	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		t.Fatalf("open the shell session: %v", err)
	}
	active := &activeSession{client: client, session: session, config: config}
	service.sessions[config.ID] = active
	t.Cleanup(func() {
		// Сессия уже может быть закрыта самим тестом, поэтому берём ту, что поймали, а не ищем снова.
		_ = session.Close()
		closeSFTPConnection(active)
		_ = client.Close()
	})
	return service
}

type noopSSHEmitter struct{}

func (noopSSHEmitter) EmitConnected(string, string)                                  {}
func (noopSSHEmitter) EmitData(string, []byte)                                       {}
func (noopSSHEmitter) EmitClosed(string)                                             {}
func (noopSSHEmitter) EmitMetrics(string, ServerMetrics)                             {}
func (noopSSHEmitter) EmitSFTPProgress(string, string, string, string, int64, int64) {}

// useSFTP is the smallest thing withSFTP can be asked to do. The callback stands in for a directory
// listing or a transfer: what these tests check is the connection the subsystem ends up on, not the
// SFTP protocol itself, which the handshake above it already covers.
func useSFTP(service *SshService, sessionID string) error {
	return service.withSFTP(sessionID, func(*sftp.Client) error { return nil })
}

// TestSFTPUsesSeparateConnectionWhenSessionsAreExhausted covers the bug this fix exists for. The
// server allows one session per connection and the shell already holds it, which is exactly the
// MaxSessions 2 setup where the metrics channel takes the second slot: opening SFTP on the main
// connection is refused, so it has to get a connection of its own.
func TestSFTPUsesSeparateConnectionWhenSessionsAreExhausted(t *testing.T) {
	server := newFakeSSHServer(t, 1)
	config := server.connectionConfig()
	config.ID = "session-1"
	service := newTestService(t, config)

	if err := useSFTP(service, config.ID); err != nil {
		t.Fatalf("expected SFTP to work on its own connection: %v", err)
	}

	if connections, _ := server.stats(); connections != 2 {
		t.Fatalf("expected a second connection for SFTP, got %d connections", connections)
	}
}

// TestSFTPDoesNotTouchTheMainConnection pins the point of the change: SFTP never opens a channel on
// the connection the terminal runs on, however many sessions that connection still has free.
func TestSFTPDoesNotTouchTheMainConnection(t *testing.T) {
	server := newFakeSSHServer(t, 16)
	config := server.connectionConfig()
	config.ID = "session-1"
	service := newTestService(t, config)

	if err := useSFTP(service, config.ID); err != nil {
		t.Fatalf("expected SFTP to work: %v", err)
	}

	if connections, rejected := server.stats(); connections != 2 || rejected != 0 {
		t.Fatalf("expected a second connection and no refused channels, got %d connections and %d refusals",
			connections, rejected)
	}
}

// TestSFTPKeepsOneClientAcrossOperations guards the channel budget: a fresh channel per directory
// listing would mean a fresh handshake each time and a race for a slot the server frees late. One
// client for the session keeps the second connection opened exactly once.
func TestSFTPKeepsOneClientAcrossOperations(t *testing.T) {
	server := newFakeSSHServer(t, 1)
	config := server.connectionConfig()
	config.ID = "session-1"
	service := newTestService(t, config)

	for range 5 {
		if err := useSFTP(service, config.ID); err != nil {
			t.Fatalf("expected SFTP to keep working: %v", err)
		}
	}

	if connections, _ := server.stats(); connections != 2 {
		t.Fatalf("expected the SFTP connection to be reused, got %d connections", connections)
	}
}

// TestSFTPRebuildsTheClientAfterAFailedOperation checks that a failed operation does not leave a
// half-dead client behind: it is dropped, and the next operation starts from a clean connection.
func TestSFTPRebuildsTheClientAfterAFailedOperation(t *testing.T) {
	server := newFakeSSHServer(t, 1)
	config := server.connectionConfig()
	config.ID = "session-1"
	service := newTestService(t, config)

	if err := useSFTP(service, config.ID); err != nil {
		t.Fatalf("expected SFTP to work: %v", err)
	}

	active := service.sessions[config.ID]
	if active.sftpConn == nil {
		t.Fatal("expected a separate connection to be kept for SFTP")
	}

	operation := errors.New("read remote directory: broken pipe")
	if err := service.withSFTP(config.ID, func(*sftp.Client) error { return operation }); !errors.Is(err, operation) {
		t.Fatalf("expected the operation error to reach the caller, got %v", err)
	}
	if active.sftp != nil {
		t.Fatal("expected the failed operation to drop the SFTP client")
	}
	if active.sftpConn != nil {
		t.Fatal("expected the failed operation to drop its connection")
	}

	if err := useSFTP(service, config.ID); err != nil {
		t.Fatalf("expected SFTP to recover on a new connection: %v", err)
	}
	if active.sftpConn == nil {
		t.Fatal("expected SFTP to be raised again after the failure")
	}
}

// TestDisconnectClosesSFTPConnection checks that the connection SFTP opened does not stay on the
// server after the session is dropped.
func TestDisconnectClosesSFTPConnection(t *testing.T) {
	server := newFakeSSHServer(t, 1)
	config := server.connectionConfig()
	config.ID = "session-1"
	service := newTestService(t, config)

	if err := useSFTP(service, config.ID); err != nil {
		t.Fatalf("expected SFTP to work: %v", err)
	}

	active := service.sessions[config.ID]
	if active.sftpConn == nil {
		t.Fatal("expected a separate connection to be kept for SFTP")
	}

	service.Disconnect(config.ID)
	if active.sftp != nil || active.sftpConn != nil {
		t.Fatal("expected Disconnect to close the SFTP client and its connection")
	}
}

func TestSFTPReportsMissingSession(t *testing.T) {
	service := NewSshService(&noopSSHEmitter{}, nil)
	if err := useSFTP(service, "missing"); err == nil {
		t.Fatal("expected an error for an unknown session")
	}
}

type recordingEmitter struct {
	noopSSHEmitter
	remoteAddress string
	emitted       bool
}

func (e *recordingEmitter) EmitConnected(_, remoteAddress string) {
	e.remoteAddress = remoteAddress
	e.emitted = true
}

func TestConnectReportsTheAddressTheConnectionActuallyReached(t *testing.T) {
	server := newFakeSSHServer(t, 16)
	config := server.connectionConfig()
	config.ID = "session-1"
	emitter := &recordingEmitter{}
	service := NewSshService(emitter, nil)

	if err := service.Connect(config); err != nil {
		t.Fatalf("connect to the test server: %v", err)
	}
	t.Cleanup(func() { service.Disconnect(config.ID) })

	if !emitter.emitted {
		t.Fatal("expected Connect to report the remote address")
	}
	if emitter.remoteAddress != "127.0.0.1" {
		t.Fatalf("expected the resolved address 127.0.0.1, got %q", emitter.remoteAddress)
	}
	if strings.Contains(emitter.remoteAddress, ":") {
		t.Fatalf("expected the address without a port, got %q", emitter.remoteAddress)
	}
}
