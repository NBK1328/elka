package emitters

import (
	"encoding/base64"

	"github.com/wailsapp/wails/v3/pkg/application"

	"elka-desktop/backend/internal/services/ssh"
)

type WailsSSHEmitter struct {
	app *application.App
}

type SSHDataPayload struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

type SSHConnectedPayload struct {
	ID            string `json:"id"`
	RemoteAddress string `json:"remoteAddress"`
}

type SSHClosedPayload struct {
	ID string `json:"id"`
}

type SFTPProgressPayload struct {
	ID          string `json:"id"`
	Direction   string `json:"direction"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Transferred int64  `json:"transferred"`
	Total       int64  `json:"total"`
}

type SSHMetricsPayload struct {
	ID     string  `json:"id"`
	CPU    float64 `json:"cpu"`
	IOWait float64 `json:"ioWait"`
	// Load average за минуту, пять и пятнадцать минут, как в top.
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
	Memory float64 `json:"memory"`
	Swap   float64 `json:"swap"`
	Disk   float64 `json:"disk"`
	// Сеть в байтах на секунду.
	NetworkIn  float64 `json:"networkIn"`
	NetworkOut float64 `json:"networkOut"`
	// Время работы в секундах и счётчики процессов.
	Uptime           float64 `json:"uptime"`
	ProcessesRunning float64 `json:"processesRunning"`
	ProcessesTotal   float64 `json:"processesTotal"`
}

const (
	SSHConnectedEvent = "ssh:connected"
	SSHDataEvent      = "ssh:data"
	SSHClosedEvent    = "ssh:closed"
	SSHMetricsEvent   = "ssh:metrics"
	SFTPProgressEvent = "sftp:progress"
)

func NewWailsSSHEmitter(app *application.App) *WailsSSHEmitter {
	return &WailsSSHEmitter{app: app}
}

func (e *WailsSSHEmitter) EmitConnected(sessionID, remoteAddress string) {
	e.app.Event.Emit(SSHConnectedEvent, SSHConnectedPayload{
		ID:            sessionID,
		RemoteAddress: remoteAddress,
	})
}

func (e *WailsSSHEmitter) EmitData(sessionID string, data []byte) {
	e.app.Event.Emit(SSHDataEvent, SSHDataPayload{
		ID:   sessionID,
		Data: base64.StdEncoding.EncodeToString(data),
	})
}

func (e *WailsSSHEmitter) EmitClosed(sessionID string) {
	e.app.Event.Emit(SSHClosedEvent, SSHClosedPayload{
		ID: sessionID,
	})
}

func (e *WailsSSHEmitter) EmitSFTPProgress(sessionID, direction, name, remotePath string, transferred, total int64) {
	e.app.Event.Emit(SFTPProgressEvent, SFTPProgressPayload{
		ID:          sessionID,
		Direction:   direction,
		Name:        name,
		Path:        remotePath,
		Transferred: transferred,
		Total:       total,
	})
}

func (e *WailsSSHEmitter) EmitMetrics(sessionID string, metrics ssh.ServerMetrics) {
	e.app.Event.Emit(SSHMetricsEvent, SSHMetricsPayload{
		ID:               sessionID,
		CPU:              metrics.CPU,
		IOWait:           metrics.IOWait,
		Load1:            metrics.Load1,
		Load5:            metrics.Load5,
		Load15:           metrics.Load15,
		Memory:           metrics.Memory,
		Swap:             metrics.Swap,
		Disk:             metrics.Disk,
		NetworkIn:        metrics.NetworkIn,
		NetworkOut:       metrics.NetworkOut,
		Uptime:           metrics.Uptime,
		ProcessesRunning: metrics.ProcessesRunning,
		ProcessesTotal:   metrics.ProcessesTotal,
	})
}
