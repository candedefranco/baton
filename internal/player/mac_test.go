package player

import (
	"context"
	"os"
	"runtime"
	"testing"
)

// TestRealMac talks to the real system, so it only runs when asked:
// BATON_INTEGRATION=1 go test ./internal/player -run RealMac -v
// It changes nothing: it reads the state and sets the volume to what it was.
func TestRealMac(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("BATON_INTEGRATION") == "" {
		t.Skip("set BATON_INTEGRATION=1 on a Mac to run")
	}
	ctx := context.Background()
	m := NewMac()
	s, err := m.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("state: %+v", s)
	if s.Volume < 0 || s.Volume > 100 {
		t.Errorf("volume %d out of range", s.Volume)
	}
	if err := m.SetVolume(ctx, s.Volume); err != nil {
		t.Fatal(err)
	}
	after, err := m.State(ctx)
	if err != nil || after.Volume != s.Volume {
		t.Errorf("volume changed from %d to %d (%v)", s.Volume, after.Volume, err)
	}
}
