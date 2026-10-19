package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/candedefranco/baton/internal/player"
)

type fakePlayer struct {
	actions []player.Action
	volume  int
	err     error
}

func (f *fakePlayer) Do(_ context.Context, a player.Action) error {
	if f.err != nil {
		return f.err
	}
	f.actions = append(f.actions, a)
	return nil
}

func (f *fakePlayer) SetVolume(_ context.Context, v int) error {
	f.volume = v
	return f.err
}

func (f *fakePlayer) State(context.Context) (player.State, error) {
	return player.State{App: "Spotify", Track: "Song", Volume: f.volume}, f.err
}

const host = "localhost:7373"

func newServer(p *fakePlayer) http.Handler {
	s := &Server{
		Player: p,
		Web: fstest.MapFS{
			"index.html": {Data: []byte(`<meta name="baton-token" content="{{BATON_TOKEN}}">`)},
			"app.js":     {Data: []byte(`console.log("hi")`)},
		},
		Hosts: []string{host, "127.0.0.1:7373"},
		Token: "secret",
	}
	return s.Handler()
}

func do(h http.Handler, method, path, body string, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://"+host+path, strings.NewReader(body))
	if token != "" {
		r.Header.Set(TokenHeader, token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestIndexCarriesTheToken(t *testing.T) {
	w := do(newServer(&fakePlayer{}), "GET", "/", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `content="secret"`) {
		t.Fatalf("GET / = %d %q", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Error("the page holds a per-run token, so it shouldn't be cached")
	}
	if w := do(newServer(&fakePlayer{}), "GET", "/app.js", "", ""); w.Code != 200 {
		t.Errorf("GET /app.js = %d", w.Code)
	}
}

func TestActions(t *testing.T) {
	p := &fakePlayer{}
	h := newServer(p)
	for _, a := range []string{"playpause", "next", "previous"} {
		if w := do(h, "POST", "/api/action", `{"action":"`+a+`"}`, "secret"); w.Code != http.StatusNoContent {
			t.Errorf("%s = %d %s", a, w.Code, w.Body)
		}
	}
	if len(p.actions) != 3 || p.actions[1] != player.Next {
		t.Errorf("actions = %v", p.actions)
	}
	if w := do(h, "POST", "/api/action", `{"action":"volume","value":64}`, "secret"); w.Code != http.StatusNoContent || p.volume != 64 {
		t.Errorf("volume = %d, player volume %d", w.Code, p.volume)
	}
}

func TestAPINeedsTheToken(t *testing.T) {
	p := &fakePlayer{}
	h := newServer(p)
	for _, token := range []string{"", "wrong"} {
		if w := do(h, "POST", "/api/action", `{"action":"next"}`, token); w.Code != http.StatusForbidden {
			t.Errorf("action with token %q = %d, want 403", token, w.Code)
		}
		if w := do(h, "GET", "/api/state", "", token); w.Code != http.StatusForbidden {
			t.Errorf("state with token %q = %d, want 403", token, w.Code)
		}
	}
	if len(p.actions) != 0 {
		t.Errorf("nothing should have run, got %v", p.actions)
	}
}

func TestOtherHostsAreRejected(t *testing.T) {
	h := newServer(&fakePlayer{})
	// A DNS-rebound name pointing at 127.0.0.1 would reach the server with
	// its own Host header, and could otherwise read the token from the page.
	r := httptest.NewRequest("GET", "http://evil.example:7373/", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusMisdirectedRequest || strings.Contains(w.Body.String(), "secret") {
		t.Errorf("foreign host got %d %q", w.Code, w.Body)
	}
}

func TestBadRequests(t *testing.T) {
	p := &fakePlayer{}
	h := newServer(p)
	for _, body := range []string{`{"action":"shutdown"}`, `not json`, `{"action":"` + strings.Repeat("x", 2000) + `"}`} {
		if w := do(h, "POST", "/api/action", body, "secret"); w.Code != http.StatusBadRequest {
			t.Errorf("body %.30q = %d, want 400", body, w.Code)
		}
	}
	if w := do(h, "GET", "/api/action?action=next", "", "secret"); w.Code < 400 || len(p.actions) != 0 {
		t.Errorf("GET /api/action = %d and ran %v; actions must be POSTs", w.Code, p.actions)
	}
}

func TestState(t *testing.T) {
	w := do(newServer(&fakePlayer{volume: 33}), "GET", "/api/state", "", "secret")
	var s player.State
	if err := json.NewDecoder(w.Body).Decode(&s); err != nil || w.Code != 200 {
		t.Fatalf("state = %d, %v", w.Code, err)
	}
	if s.App != "Spotify" || s.Volume != 33 {
		t.Errorf("state = %+v", s)
	}
}

func TestErrors(t *testing.T) {
	h := newServer(&fakePlayer{err: player.ErrNoPlayer})
	w := do(h, "POST", "/api/action", `{"action":"next"}`, "secret")
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "open Spotify or Music") {
		t.Errorf("no player = %d %s", w.Code, w.Body)
	}
	h = newServer(&fakePlayer{err: errors.New("osascript: not authorized")})
	if w := do(h, "GET", "/api/state", "", "secret"); w.Code != http.StatusInternalServerError {
		t.Errorf("failing player = %d", w.Code)
	}
}

func TestNewTokenIsRandom(t *testing.T) {
	a, b := NewToken(), NewToken()
	if len(a) != 32 || a == b {
		t.Errorf("tokens %q and %q", a, b)
	}
}
