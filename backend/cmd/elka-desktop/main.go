package main

import (
	"database/sql"
	"elka-desktop/backend/cmd/elka-desktop/emitters"
	"elka-desktop/backend/cmd/elka-desktop/env"
	"elka-desktop/backend/internal/dbgen"
	"elka-desktop/backend/internal/migration"
	"elka-desktop/backend/internal/services/auth"
	"elka-desktop/backend/internal/services/blob"
	"elka-desktop/backend/internal/services/settings"
	"elka-desktop/backend/internal/services/ssh"
	"elka-desktop/backend/internal/services/updater"
	"elka-desktop/backend/internal/vault"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/quaadgras/velopack-go/velopack"

	root "elka-desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func init() {
	// Register a custom event whose associated data type is string.
	// This is not required, but the binding generator will pick up registered events
	// and provide a strongly typed JS/TS API for them.

	application.RegisterEvent[emitters.SSHConnectedPayload](emitters.SSHConnectedEvent)
	application.RegisterEvent[emitters.SSHDataPayload](emitters.SSHDataEvent)
	application.RegisterEvent[emitters.SSHClosedPayload](emitters.SSHClosedEvent)
	application.RegisterEvent[emitters.SSHMetricsPayload](emitters.SSHMetricsEvent)
	application.RegisterEvent[emitters.SFTPProgressPayload](emitters.SFTPProgressEvent)

	application.RegisterEvent[emitters.UpdaterProgressPayload](emitters.UpdaterProgressEvent)
}

const AppName = "Elka"
const appDataDirName = "Elka"
const legacyAppDataDirName = "Terminator" // Previous application name; its folder is migrated to appDataDirName on first start.
const dbFile = "elka.db"
const legacyDbFile = "terminator.db"
const devDbFile = "dev.db"
const logFileName = "elka.log"
const legacyLogFileName = "terminator.log"
const crashLogFileName = "crash.log"

func main() {
	velopack.Run(velopack.App{
		AutoApplyOnStartup: true,
	})

	for _, arg := range os.Args {
		switch arg {
		case "--veloapp-install",
			"--veloapp-uninstall",
			"--veloapp-obsolete":
			os.Exit(0)
		}
	}

	isDebug := env.IsDebug

	appDir, err := getAppDir(isDebug)
	if err != nil {
		log.Fatal(fmt.Errorf("error getting app directory: %w", err))
	}

	logPath := filepath.Join(appDir, logFileName)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		log.Fatal(fmt.Errorf("error opening log file: %w", err))
	}
	defer func(logFile *os.File) {
		_ = logFile.Close()
	}(logFile)

	var multiWriter io.Writer
	if isDebug {
		multiWriter = io.MultiWriter(os.Stdout, logFile)
	} else {
		multiWriter = io.MultiWriter(logFile)
	}
	logger := slog.New(slog.NewTextHandler(multiWriter, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	crashPath := filepath.Join(appDir, crashLogFileName)
	crashFile, err := os.OpenFile(crashPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		log.Fatal(fmt.Errorf("error opening crash log file: %w", err))
	}
	err = debug.SetCrashOutput(crashFile, debug.CrashOptions{})
	if err != nil {
		log.Fatal(fmt.Errorf("error setting crash output: %w", err))
	}

	slog.Info("Environment", "IsDebug", isDebug)

	var mainWindow *application.WebviewWindow

	// Create a new Wails application by providing the necessary options.
	// Variables 'Name' and 'Description' are for application metadata.
	// 'Assets' configures the asset server with the 'FS' variable pointing to the frontend files.
	// 'Bind' is a list of Go struct instances. The frontend has access to the methods of these instances.
	// 'Mac' options tailor the application when running an macOS.
	app := application.New(application.Options{
		Name:        AppName,
		Description: "Elka SSH client",
		Logger:      logger,
		//Services: []application.Service{
		//},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(root.Frontend),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Windows: application.WindowsOptions{
			WebviewUserDataPath: filepath.Join(appDir, "webview2"),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.elka.desktop",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if mainWindow != nil {
					mainWindow.Restore()
					mainWindow.Focus()
				}

				slog.Info("Second instance launched", "args", data.Args)
				slog.Info("Working directory", "dir", data.WorkingDir)
				slog.Info("Additional data", "data", data.AdditionalData)
			},
		},
	})

	databaseName := dbFile
	if isDebug {
		databaseName = devDbFile
	}
	restartVault := &atomic.Bool{}
	settingsService := settings.NewSettingsService(appDir, databaseName, app, func() {
		restartVault.Store(true)
		go func() {
			time.Sleep(350 * time.Millisecond)
			app.Quit()
		}()
	})
	if err = settings.ApplyPendingVaultDirectory(appDir, databaseName); err != nil {
		slog.Error("failed to move vault to its pending location", "error", err)
	}
	appSettings, err := settingsService.GetSettings()
	if err != nil {
		log.Fatal(fmt.Errorf("error reading app settings: %w", err))
	}
	dbPath := getDbDir(appDir, isDebug, appSettings.VaultDirectory)
	if err = os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		log.Fatal(fmt.Errorf("error creating vault directory: %w", err))
	}
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatal(fmt.Errorf("error building db: %w", err))
	}
	defer func(db *sql.DB) {
		_ = db.Close()
	}(db)
	queries := dbgen.New(db)

	err = migration.RunMigrations(db)
	if err != nil {
		log.Fatal(fmt.Errorf("error migrating db: %w", err))
	}

	v := vault.New()
	sshEmitter := emitters.NewWailsSSHEmitter(app)
	updaterEmitter := emitters.NewWailsUpdaterEmitter(app)

	authService := auth.NewAuthService(queries, v)
	sshService := ssh.NewSshService(sshEmitter, app)
	hostService := blob.NewHostService(queries, v)
	hostTransferService := blob.NewHostTransferService(queries, v, app)
	keyService := blob.NewKeyService(queries, v)
	credentialService := blob.NewCredentialService(queries, v)
	groupService := blob.NewGroupService(queries, v)
	updaterService := updater.NewUpdaterService(updaterEmitter, appDir)

	app.RegisterService(application.NewService(authService))
	app.RegisterService(application.NewService(sshService))
	app.RegisterService(application.NewService(hostService))
	app.RegisterService(application.NewService(hostTransferService))
	app.RegisterService(application.NewService(keyService))
	app.RegisterService(application.NewService(credentialService))
	app.RegisterService(application.NewService(groupService))
	app.RegisterService(application.NewService(settingsService))
	app.RegisterService(application.NewService(updaterService))
	app.RegisterService(application.NewService(&WindowControls{mainWindow}))

	// Create a new window with the necessary options.
	// 'Title' is the title of the window.
	// 'Mac' options tailor the window when running on macOS.
	// 'BackgroundColour' is the background colour of the window.
	// 'URL' is the URL that will be loaded into the webview.
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:          AppName,
		Width:          1200,
		Height:         900,
		EnableFileDrop: true,
		Frameless:      runtime.GOOS == "windows",
		Mac: application.MacWindow{
			// Keep the native drag zone above the tab row; tabs start below this strip.
			InvisibleTitleBarHeight: 16,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: windowBackgroundColour(appSettings.AppBackgroundColor),
		URL:              "/",
	})

	defer v.Lock() // eh why not

	// Run the application. This blocks until the application has been exited.
	err = app.Run()

	// If an error occurred while running the application, log it and exit.
	if err != nil {
		log.Fatal(err)
	}
	if restartVault.Load() {
		if err = db.Close(); err != nil {
			slog.Error("failed to close the current vault", "error", err)
		}
		executablePath, executableErr := os.Executable()
		if executableErr != nil {
			log.Fatal(fmt.Errorf("failed to locate executable for restart: %w", executableErr))
		}
		if err = exec.Command(executablePath, os.Args[1:]...).Start(); err != nil {
			log.Fatal(fmt.Errorf("failed to restart after vault move: %w", err))
		}
		return
	}
}

// windowBackgroundColour paints the native window in the theme the user picked. Otherwise the window
// shows the default dark colour until the webview renders the splash, which reads as a black flash on
// light themes.
func windowBackgroundColour(hex string) application.RGBA {
	trimmed := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(trimmed) == 6 {
		if value, err := strconv.ParseUint(trimmed, 16, 32); err == nil {
			return application.NewRGB(uint8(value>>16), uint8(value>>8), uint8(value))
		}
	}

	return application.NewRGB(9, 9, 11)
}

func getAppDir(isDebug bool) (string, error) {
	if isDebug {
		executablePath, err := os.Executable()
		if err != nil {
			return "", err
		}
		executableDir := filepath.Dir(executablePath)
		return filepath.Join(executableDir, ".."), nil
	}

	userDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	appDir := filepath.Join(userDir, appDataDirName)

	if err = migrateLegacyData(userDir, appDir); err != nil {
		slog.Warn("failed to migrate legacy application directory", "error", err)
	}

	if err = os.MkdirAll(appDir, 0755); err != nil {
		return "", err
	}

	return appDir, nil
}

// migrateLegacyData renames the folder and files left by the previous application name so existing
// settings, vaults and logs stay available. Anything already created for the current names wins.
func migrateLegacyData(userDir, appDir string) error {
	if err := migrateLegacyAppDir(userDir, appDir); err != nil {
		return err
	}
	return migrateLegacyDataFiles(appDir)
}

func migrateLegacyAppDir(userDir, appDir string) error {
	legacyDir := filepath.Join(userDir, legacyAppDataDirName)
	legacyInfo, err := os.Stat(legacyDir)
	if err != nil {
		return nil
	}
	if !legacyInfo.IsDir() {
		return nil
	}
	if _, err = os.Stat(appDir); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(legacyDir, appDir)
}

func migrateLegacyDataFiles(appDir string) error {
	renames := [][2]string{
		{legacyDbFile, dbFile},
		{legacyDbFile + "-wal", dbFile + "-wal"},
		{legacyDbFile + "-shm", dbFile + "-shm"},
		{legacyLogFileName, logFileName},
	}
	for _, rename := range renames {
		if err := renameIfAbsent(filepath.Join(appDir, rename[0]), filepath.Join(appDir, rename[1])); err != nil {
			return err
		}
	}
	return nil
}

func renameIfAbsent(source, target string) error {
	if _, err := os.Stat(source); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(source, target)
}

func getDbDir(appDir string, isDebug bool, vaultDirectory string) string {
	if vaultDirectory != "" {
		fileName := dbFile
		if isDebug {
			fileName = devDbFile
		}
		return filepath.Join(vaultDirectory, fileName)
	}
	if isDebug {
		return filepath.Join(appDir, devDbFile)
	}
	return filepath.Join(appDir, dbFile)
}
