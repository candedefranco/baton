// Package server serves the gesture page and turns its requests into player
// commands.
//
// Anything on the machine can reach a localhost port, including web pages
// open in other tabs. So the server only answers requests whose Host is its
// own address (which stops DNS rebinding), and every API call must carry a
// token that is only handed out inside the page it serves (which stops other
// sites from forging requests, since they can't read that page).
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/candedefranco/baton/internal/player"
)

// TokenHeader carries the API token.
const TokenHeader = "X-Baton-Token"

// tokenPlaceholder is replaced with the token when index.html is served.
const tokenPlaceholder = "{{BATON_TOKEN}}"

// Server is the HTTP side of baton.
type Server struct {
	Player player.Controller
	Web    fs.FS    // index.html and its assets
	Hosts  []string // accepted Host headers, e.g. "localhost:7373"
	Token  string
	Log    *log.Logger
}

// NewToken returns a random API token.
func NewToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand doesn't fail on supported platforms
	}
	return hex.EncodeToString(b)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.index)
	mux.Handle("GET /", http.FileServerFS(s.Web))
	mux.Handle("GET /api/state", s.api(s.state))
	mux.Handle("POST /api/action", s.api(s.action))
	return s.checkHost(mux)
}

func (s *Server) checkHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, h := range s.Hosts {
			if r.Host == h {
				next.ServeHTTP(w, r)
				return
			}
		}
		http.Error(w, "unknown host", http.StatusMisdirectedRequest)
	})
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	page, err := fs.ReadFile(s.Web, "index.html")
	if err != nil {
		http.Error(w, "missing page", http.StatusInternalServerError)
		return
	}
	page = bytes.ReplaceAll(page, []byte(tokenPlaceholder), []byte(s.Token))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(page)
}

// api wraps an API handler with the token check and a timeout for AppleScript.
func (s *Server) api(h func(ctx context.Context, w http.ResponseWriter, r *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(TokenHeader)
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) != 1 {
			writeError(w, http.StatusForbidden, "bad token")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		h(ctx, w, r)
	})
}

func (s *Server) state(ctx context.Context, w http.ResponseWriter, _ *http.Request) {
	st, err := s.Player.State(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(st)
}

// ActionRequest is the body of POST /api/action: a playback action, or
// "volume" with a level.
type ActionRequest struct {
	Action string `json:"action"`
	Value  int    `json:"value"`
}

func (s *Server) action(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	var req ActionRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request body")
		return
	}
	var err error
	switch a := player.Action(req.Action); {
	case req.Action == "volume":
		err = s.Player.SetVolume(ctx, req.Value)
	case a.Valid():
		err = s.Player.Do(ctx, a)
	default:
		writeError(w, http.StatusBadRequest, "unknown action")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	if s.Log != nil {
		if req.Action == "volume" {
			s.Log.Printf("volume %d", player.ClampVolume(req.Value))
		} else {
			s.Log.Printf("%s", req.Action)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	if errors.Is(err, player.ErrNoPlayer) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if s.Log != nil {
		s.Log.Printf("error: %v", err)
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
