package player

import (
	"context"
	"sync"
)

// DryRun pretends to be a player, so the gestures can be tried anywhere
// without touching real music: it keeps its state in memory.
type DryRun struct {
	mu      sync.Mutex
	track   int
	playing bool
	volume  int
}

type song struct{ title, artist string }

var playlist = []song{
	{"Neon Skyline", "The Pixels"},
	{"Goroutine", "Channel Orange Juice"},
	{"Half Block Heart", "Terminal Velocity"},
	{"Night Shift", "Bubble Tea"},
}

func NewDryRun() *DryRun { return &DryRun{volume: 40} }

func (d *DryRun) Do(_ context.Context, a Action) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch a {
	case PlayPause:
		d.playing = !d.playing
	case Next:
		d.track = (d.track + 1) % len(playlist)
		d.playing = true
	case Previous:
		d.track = (d.track + len(playlist) - 1) % len(playlist)
		d.playing = true
	default:
		return errUnknown(a)
	}
	return nil
}

func (d *DryRun) SetVolume(_ context.Context, v int) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.volume = ClampVolume(v)
	return nil
}

func (d *DryRun) State(context.Context) (State, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := playlist[d.track]
	return State{App: "Dry run", Playing: d.playing, Track: s.title, Artist: s.artist, Volume: d.volume, DryRun: true}, nil
}
