// Command baton lets you control the music on your Mac with hand gestures:
// it serves a page that watches your hand through the webcam, and plays,
// pauses, skips and sets the volume in Spotify or Music.
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/candedefranco/baton/internal/player"
	"github.com/candedefranco/baton/internal/server"
)

//go:embed web/index.html web/style.css web/app.js web/gestures.js
var webFiles embed.FS

func main() {
	port := flag.Int("port", 7373, "port to listen on (localhost only)")
	dryRun := flag.Bool("dry-run", false, "pretend to be a music player instead of controlling the real one")
	noOpen := flag.Bool("no-open", false, "don't open the browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "baton: control the music on your Mac with hand gestures\n\nUsage: baton [flags]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if *showVersion {
		fmt.Println("baton", version())
		return
	}

	var p player.Controller
	switch {
	case *dryRun:
		p = player.NewDryRun()
	case runtime.GOOS == "darwin":
		p = player.NewMac()
	default:
		fmt.Fprintln(os.Stderr, "baton controls Spotify and Music, which needs macOS. Run `baton --dry-run` to try the gestures anyway.")
		os.Exit(1)
	}

	if err := run(p, *port, !*noOpen, *dryRun); err != nil {
		fmt.Fprintln(os.Stderr, "baton:", err)
		os.Exit(1)
	}
}

func run(p player.Controller, port int, open, dryRun bool) error {
	web, err := fs.Sub(webFiles, "web")
	if err != nil {
		return err
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("can't listen on %s (is baton already running? try --port): %w", addr, err)
	}
	url := fmt.Sprintf("http://localhost:%d", port)
	srv := &server.Server{
		Player: p,
		Web:    web,
		Hosts:  []string{fmt.Sprintf("localhost:%d", port), addr},
		Token:  server.NewToken(),
		Log:    log.New(os.Stdout, "  ", log.Ltime),
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}

	mode := ""
	if dryRun {
		mode = " (dry run: your music won't be touched)"
	}
	fmt.Printf("baton is listening on %s%s\nCtrl+C to quit.\n", url, mode)
	if open {
		openBrowser(url)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = hs.Shutdown(shutdown)
	}()
	if err := hs.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	fmt.Println("\nbye")
	return nil
}

// version is the module version when installed with `go install`.
func version() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
