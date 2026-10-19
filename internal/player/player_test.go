package player

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeMac records the scripts it's asked to run and answers with canned output.
type fakeMac struct {
	running map[string]bool
	scripts []string
	out     string
	err     error
}

func (f *fakeMac) mac() *Mac {
	return &Mac{
		Run: func(_ context.Context, s string) (string, error) {
			f.scripts = append(f.scripts, s)
			return f.out, f.err
		},
		Running: func(_ context.Context, name string) bool { return f.running[name] },
	}
}

func TestActionsTalkToTheRunningApp(t *testing.T) {
	cases := []struct {
		running map[string]bool
		action  Action
		want    string
	}{
		{map[string]bool{"Spotify": true}, PlayPause, `tell application "Spotify" to playpause`},
		{map[string]bool{"Music": true}, Next, `tell application "Music" to next track`},
		{map[string]bool{"Spotify": true, "Music": true}, Previous, `tell application "Spotify" to previous track`},
	}
	for _, c := range cases {
		f := &fakeMac{running: c.running}
		if err := f.mac().Do(context.Background(), c.action); err != nil {
			t.Fatal(err)
		}
		if len(f.scripts) != 1 || f.scripts[0] != c.want {
			t.Errorf("%s with %v ran %q, want %q", c.action, c.running, f.scripts, c.want)
		}
	}
}

func TestNoPlayerOpen(t *testing.T) {
	f := &fakeMac{}
	if err := f.mac().Do(context.Background(), PlayPause); !errors.Is(err, ErrNoPlayer) {
		t.Errorf("err = %v, want ErrNoPlayer", err)
	}
	if len(f.scripts) != 0 {
		t.Errorf("no script should run without a player (macOS would ask where the app is), ran %q", f.scripts)
	}
}

func TestUnknownActionRunsNothing(t *testing.T) {
	f := &fakeMac{running: map[string]bool{"Spotify": true}}
	if err := f.mac().Do(context.Background(), "rm -rf"); err == nil {
		t.Error("an unknown action should fail")
	}
	if len(f.scripts) != 0 {
		t.Errorf("ran %q", f.scripts)
	}
}

func TestVolumeIsClamped(t *testing.T) {
	for in, want := range map[int]string{-5: "0", 42: "42", 180: "100"} {
		f := &fakeMac{}
		if err := f.mac().SetVolume(context.Background(), in); err != nil {
			t.Fatal(err)
		}
		if got := f.scripts[0]; got != "set volume output volume "+want {
			t.Errorf("SetVolume(%d) ran %q", in, got)
		}
	}
}

func TestStateFromAPlayer(t *testing.T) {
	f := &fakeMac{running: map[string]bool{"Music": true}, out: "35\nplaying\nClair de Lune\nDebussy"}
	s, err := f.mac().State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := State{App: "Music", Playing: true, Track: "Clair de Lune", Artist: "Debussy", Volume: 35}
	if s != want {
		t.Errorf("state = %+v, want %+v", s, want)
	}
	if !strings.Contains(f.scripts[0], `tell application "Music"`) {
		t.Errorf("script should ask Music: %q", f.scripts[0])
	}
}

func TestStateWithNothingPlaying(t *testing.T) {
	f := &fakeMac{running: map[string]bool{"Spotify": true}, out: "70\npaused\n\n"}
	s, err := f.mac().State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Playing || s.Track != "" || s.Volume != 70 {
		t.Errorf("state = %+v", s)
	}
}

func TestStateWithoutAPlayerStillReadsTheVolume(t *testing.T) {
	f := &fakeMac{out: "19"}
	s, err := f.mac().State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s != (State{Volume: 19}) {
		t.Errorf("state = %+v", s)
	}
	if strings.Contains(f.scripts[0], "tell application") {
		t.Errorf("no app should be named when none is open: %q", f.scripts[0])
	}
}

func TestStateReportsBadOutput(t *testing.T) {
	f := &fakeMac{running: map[string]bool{"Spotify": true}, out: "loud\nplaying"}
	if _, err := f.mac().State(context.Background()); err == nil {
		t.Error("a non-numeric volume should be an error")
	}
	f = &fakeMac{running: map[string]bool{"Spotify": true}, err: errors.New("not allowed")}
	if _, err := f.mac().State(context.Background()); err == nil {
		t.Error("a failing script should be an error")
	}
}

func TestDryRun(t *testing.T) {
	ctx := context.Background()
	d := NewDryRun()
	s0, _ := d.State(ctx)
	if !s0.DryRun || s0.Playing {
		t.Fatalf("initial state = %+v", s0)
	}
	_ = d.Do(ctx, PlayPause)
	_ = d.Do(ctx, Next)
	_ = d.SetVolume(ctx, 250)
	s, _ := d.State(ctx)
	if !s.Playing || s.Track == s0.Track || s.Volume != 100 {
		t.Errorf("state = %+v", s)
	}
	_ = d.Do(ctx, Previous)
	if s, _ = d.State(ctx); s.Track != s0.Track {
		t.Errorf("previous should go back to %q, got %q", s0.Track, s.Track)
	}
	if err := d.Do(ctx, "dance"); err == nil {
		t.Error("unknown actions should fail")
	}
}
