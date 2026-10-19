// Package player controls whichever music app is playing on the Mac, and the
// system volume.
package player

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Action is a playback command.
type Action string

const (
	PlayPause Action = "playpause"
	Next      Action = "next"
	Previous  Action = "previous"
)

// Valid reports whether a is a known action.
func (a Action) Valid() bool {
	switch a {
	case PlayPause, Next, Previous:
		return true
	}
	return false
}

// State is what's playing and how loud.
type State struct {
	App     string `json:"app"` // "Spotify", "Music", or "" when neither is open
	Playing bool   `json:"playing"`
	Track   string `json:"track"`
	Artist  string `json:"artist"`
	Volume  int    `json:"volume"` // system output volume, 0-100
	DryRun  bool   `json:"dryRun"`
}

// Controller is a music player plus the system volume.
type Controller interface {
	Do(ctx context.Context, a Action) error
	SetVolume(ctx context.Context, v int) error
	State(ctx context.Context) (State, error)
}

// ErrNoPlayer means neither Spotify nor Music is open.
var ErrNoPlayer = errors.New("open Spotify or Music first")

// apps are the players baton knows, in order of preference. Each is both the
// process name and the AppleScript application name.
var apps = []string{"Spotify", "Music"}

// Mac controls Spotify or Music with AppleScript.
type Mac struct {
	// Run runs an AppleScript and returns its output; Osascript by default.
	Run func(ctx context.Context, script string) (string, error)
	// Running reports whether a process is open; Pgrep by default.
	Running func(ctx context.Context, name string) bool
}

// NewMac returns a controller that drives the real apps.
func NewMac() *Mac { return &Mac{Run: Osascript, Running: Pgrep} }

// Osascript runs an AppleScript.
func Osascript(ctx context.Context, script string) (string, error) {
	out, err := exec.CommandContext(ctx, "osascript", "-e", script).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("osascript: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// Pgrep reports whether a process with exactly this name is running.
func Pgrep(ctx context.Context, name string) bool {
	return exec.CommandContext(ctx, "pgrep", "-xq", name).Run() == nil
}

// app returns the player to talk to. It checks the process list first:
// naming an app in a script that isn't installed makes macOS ask where it is.
func (m *Mac) app(ctx context.Context) string {
	for _, a := range apps {
		if m.Running(ctx, a) {
			return a
		}
	}
	return ""
}

var actionScripts = map[Action]string{
	PlayPause: "playpause",
	Next:      "next track",
	Previous:  "previous track",
}

func (m *Mac) Do(ctx context.Context, a Action) error {
	cmd, ok := actionScripts[a]
	if !ok {
		return errUnknown(a)
	}
	app := m.app(ctx)
	if app == "" {
		return ErrNoPlayer
	}
	_, err := m.Run(ctx, fmt.Sprintf("tell application %q to %s", app, cmd))
	return err
}

func errUnknown(a Action) error { return fmt.Errorf("unknown action %q", a) }

// ClampVolume keeps v in 0..100.
func ClampVolume(v int) int { return max(0, min(100, v)) }

func (m *Mac) SetVolume(ctx context.Context, v int) error {
	_, err := m.Run(ctx, fmt.Sprintf("set volume output volume %d", ClampVolume(v)))
	return err
}

// stateScript asks a player for its state, track and artist, one per line,
// after the system volume. Standard Additions (the volume) stays outside the
// tell block, where it belongs.
const stateScript = `set vol to output volume of (get volume settings)
tell application %q
	set st to player state as string
	set t to ""
	set a to ""
	try
		set t to name of current track
		set a to artist of current track
	end try
end tell
return (vol as string) & linefeed & st & linefeed & t & linefeed & a`

const volumeScript = `output volume of (get volume settings)`

func (m *Mac) State(ctx context.Context) (State, error) {
	app := m.app(ctx)
	if app == "" {
		out, err := m.Run(ctx, volumeScript)
		if err != nil {
			return State{}, err
		}
		v, err := strconv.Atoi(out)
		return State{Volume: v}, err
	}
	out, err := m.Run(ctx, fmt.Sprintf(stateScript, app))
	if err != nil {
		return State{}, err
	}
	return parseState(app, out)
}

func parseState(app, out string) (State, error) {
	lines := strings.SplitN(out, "\n", 4)
	for len(lines) < 4 {
		lines = append(lines, "")
	}
	v, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		return State{}, fmt.Errorf("reading the volume from %q: %w", lines[0], err)
	}
	return State{
		App:     app,
		Volume:  v,
		Playing: strings.TrimSpace(lines[1]) == "playing",
		Track:   strings.TrimSpace(lines[2]),
		Artist:  strings.TrimSpace(lines[3]),
	}, nil
}
