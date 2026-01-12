package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"gopkg.in/yaml.v3"
)

//
// ================= CONFIG =================
//

type Config struct {
	Server *ServerConfig        `yaml:"server,omitempty"`
	Apps   map[string]AppConfig `yaml:"apps"`
}

type ServerConfig struct {
	Addr         string `yaml:"addr,omitempty"`
	DefaultLines int    `yaml:"default_lines,omitempty"`
	MaxLines     int    `yaml:"max_lines,omitempty"`
}

type AppConfig struct {
	Logs map[string]LogTarget `yaml:"logs"`
}

type LogTarget struct {
	Type    string `yaml:"type"`
	Path    string `yaml:"path,omitempty"`
	URL     string `yaml:"url,omitempty"`
	Service string `yaml:"service"`
}

var globalConfig *Config

//
// ================= STREAM MANAGER =================
//

var streamMgr = NewStreamManager(DefaultStreamConfig())

//
// ================= STREAM STATUS =================
//

type StreamStatus struct {
	Active    bool      `json:"active"`
	AppName   string    `json:"app_name,omitempty"`
	LogType   string    `json:"log_type,omitempty"`
	Path      string    `json:"path,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
}

var currentStream = &StreamStatus{}

//
// ================= OUTPUT SCHEMA =================
//

type LogOutput struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Service   string `json:"service"`
	Message   string `json:"message"`
}

//
// ================= UTF-16 FILE READER =================
//

func readFileAutoUTF(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	if len(data) > 2 && data[0] == 0xFF && data[1] == 0xFE {
		u16 := make([]uint16, (len(data)-2)/2)
		for i := range u16 {
			u16[i] = binary.LittleEndian.Uint16(data[2+i*2:])
		}
		return string(utf16.Decode(u16)), nil
	}

	if len(data) > 2 && data[0] == 0xFE && data[1] == 0xFF {
		u16 := make([]uint16, (len(data)-2)/2)
		for i := range u16 {
			u16[i] = binary.BigEndian.Uint16(data[2+i*2:])
		}
		return string(utf16.Decode(u16)), nil
	}

	return string(data), nil
}

//
// ================= LOG SOURCES =================
//

type LogSource interface {
	ReadLogs(ctx context.Context, lines int) (string, error)
}

type FileLogSource struct {
	Path string
}

func (f *FileLogSource) ReadLogs(ctx context.Context, lines int) (string, error) {
	content, err := readFileAutoUTF(f.Path)
	if err != nil {
		return "", err
	}

	var all []string
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		all = append(all, sc.Text())
	}

	if lines <= 0 || lines > len(all) {
		lines = len(all)
	}

	return strings.Join(all[len(all)-lines:], "\n"), nil
}

type APILogSource struct {
	URL string
}

func (a *APILogSource) ReadLogs(ctx context.Context, lines int) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

//
// ================= HELPERS =================
//

func parseLines(r *http.Request) int {
	n, err := strconv.Atoi(r.URL.Query().Get("lines"))
	if err != nil || n <= 0 {
		return globalConfig.Server.DefaultLines
	}
	if n > globalConfig.Server.MaxLines {
		return globalConfig.Server.MaxLines
	}
	return n
}

func sourceFromConfig(app, key string) (LogSource, LogTarget, error) {
	a, ok := globalConfig.Apps[app]
	if !ok {
		return nil, LogTarget{}, fmt.Errorf("unknown app")
	}
	t, ok := a.Logs[key]
	if !ok {
		return nil, LogTarget{}, fmt.Errorf("unknown log key")
	}
	if t.Type == "file" {
		return &FileLogSource{Path: t.Path}, t, nil
	}
	return &APILogSource{URL: t.URL}, t, nil
}

//
// ================= RAW LOG PARSER =================
//

var springLogRegex = regexp.MustCompile(
	`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+` +
		`(DEBUG|INFO|WARN|ERROR)\s+` +
		`\d+\s+---\s+\[.*?\]\s+` +
		`([^\s]+)\s*:\s*(.*)$`,
)

func parseRawLogLine(line, severity string) map[string]interface{} {
	m := springLogRegex.FindStringSubmatch(line)

	if len(m) == 0 {
		return map[string]interface{}{
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"level":     severity,
			"service":   "unknown",
			"message":   strings.TrimSpace(line),
		}
	}

	t, err := time.Parse("2006-01-02 15:04:05.000", m[1])
	if err != nil {
		t = time.Now().UTC()
	}

	return map[string]interface{}{
		"timestamp": t.UTC().Format(time.RFC3339),
		"level":     m[2],
		"service":   m[3],
		"message":   m[4],
	}
}

//
// ================= STREAM INGEST (JSON) =================
//

type IncomingLog struct {
	Severity  string `json:"severity"`
	Timestamp string `json:"timestamp"`
	Message   string `json:"message"`
	Raw       string `json:"raw"`
}

type StreamIngestRequest struct {
	Logs []IncomingLog `json:"logs"`
}

func streamIngestHandler(w http.ResponseWriter, r *http.Request) {
	var req StreamIngestRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", 400)
		return
	}

	if len(req.Logs) == 0 {
		http.Error(w, "logs array is empty", 400)
		return
	}

	accepted := 0

	for _, l := range req.Logs {
		raw := strings.TrimSpace(l.Raw)
		if raw == "" {
			raw = strings.TrimSpace(l.Message)
		}
		if raw == "" {
			continue
		}

		log := parseRawLogLine(raw, l.Severity)
		if streamMgr.Ingest(log) {
			accepted++
		}
	}

	var bundle *CorrelationBundle
	flushed := false
	if streamMgr.ShouldFlush() {
		bundle = streamMgr.Flush()
		flushed = bundle != nil
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"received": len(req.Logs),
		"accepted": accepted,
		"flushed":  flushed,
		"bundle":   bundle,
	})
}

//
// ================= OTHER HANDLERS (UNCHANGED) =================
//

func logsHandler(w http.ResponseWriter, r *http.Request) {
	app := r.URL.Query().Get("app")
	key := r.URL.Query().Get("log")

	src, target, err := sourceFromConfig(app, key)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	raw, _ := src.ReadLogs(r.Context(), parseLines(r))
	sc := bufio.NewScanner(strings.NewReader(raw))

	var out []LogOutput
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" {
			out = append(out, LogOutput{
				Timestamp: time.Now().UTC().Format(time.RFC3339),
				Level:     "INFO",
				Service:   target.Service,
				Message:   line,
			})
		}
	}

	json.NewEncoder(w).Encode(out)
}

func streamStatusHandler(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(currentStream)
}

func streamLiveHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	flusher, _ := w.(http.Flusher)
	ch := streamMgr.Subscribe()
	defer streamMgr.Unsubscribe(ch)

	for {
		select {
		case <-r.Context().Done():
			return
		case b := <-ch:
			j, _ := json.Marshal(b)
			fmt.Fprintf(w, "data: %s\n\n", j)
			flusher.Flush()
		}
	}
}

//
// ================= RESPONSE SCHEMA =================
//

type AnalyzeResponse struct {
	Bundle AnalyzeBundle `json:"bundle"`
	UseRag bool          `json:"use_rag"`
	TopK   int           `json:"top_k"`
}

type AnalyzeBundle struct {
	ID                   string              `json:"id"`
	WindowStart          string              `json:"windowStart"`
	WindowEnd            string              `json:"windowEnd"`
	RootService          string              `json:"rootService"`
	AffectedServices     []string            `json:"affectedServices"`
	LogPatterns          []AnalyzeLogPattern `json:"logPatterns"`
	Events               []AnalyzeEvent      `json:"events"`
	Metrics              AnalyzeMetrics      `json:"metrics"`
	DependencyGraph      []string            `json:"dependencyGraph"`
	DerivedRootCauseHint string              `json:"derivedRootCauseHint"`
}

type AnalyzeLogPattern struct {
	Pattern         string  `json:"pattern"`
	Count           int     `json:"count"`
	FirstOccurrence string  `json:"firstOccurrence"`
	LastOccurrence  string  `json:"lastOccurrence"`
	ErrorClass      *string `json:"errorClass"`
}

type AnalyzeEvent struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Reason    string `json:"reason"`
	Service   string `json:"service"`
	Timestamp string `json:"timestamp"`
}

type AnalyzeMetrics struct {
	CPUZ       float64 `json:"cpuZ"`
	LatencyZ   float64 `json:"latencyZ"`
	ErrorRateZ float64 `json:"errorRateZ"`
}

type PreprocessCombinedResponse struct {
	PreprocessResponse AnalyzeResponse `json:"preprocess_response"`
	AnalyzeResponse    json.RawMessage `json:"analyze_response"`
}

//
// ================= PREPROCESS HANDLER (FIXED DYNAMICALLY) =================
//

func preprocessHandler(w http.ResponseWriter, r *http.Request) {
	// Recover from any panic to ensure we always return a JSON response
	defer func() {
		if rec := recover(); rec != nil {
			fmt.Printf("preprocessHandler panic: %v\n", rec)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(500)
			errObj := map[string]string{"error": fmt.Sprintf("panic: %v", rec)}
			errB, _ := json.Marshal(errObj)
			fallback := PreprocessCombinedResponse{
				PreprocessResponse: AnalyzeResponse{UseRag: true, TopK: 0},
				AnalyzeResponse:    json.RawMessage(errB),
			}
			b, _ := json.Marshal(fallback)
			w.Write(b)
		}
	}()

	var payload map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "invalid JSON body", 400)
		return
	}

	var rawData []map[string]interface{}
	inputBundleID := ""

	if bundle, ok := payload["bundle"].(map[string]interface{}); ok {
		if id, ok := bundle["id"].(string); ok {
			inputBundleID = id
		}
		if seq, ok := bundle["Sequence"].([]interface{}); ok {
			for _, item := range seq {
				if itmMap, ok := item.(map[string]interface{}); ok {
					if data, ok := itmMap["Data"].(map[string]interface{}); ok {
						rawData = append(rawData, data)
					}
				}
			}
		}
	}

	if len(rawData) == 0 {
		http.Error(w, "no logs found in payload", 400)
		return
	}

	processor := NewLogPreprocessorFullGo()
	bundle, err := processor.Process(rawData, inputBundleID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	var patterns []AnalyzeLogPattern
	for _, p := range bundle.LogPatterns {
		patterns = append(patterns, AnalyzeLogPattern{
			Pattern:         p.Pattern,
			Count:           p.Count,
			FirstOccurrence: p.FirstOccurrence,
			LastOccurrence:  p.LastOccurrence,
			ErrorClass:      p.ErrorClass,
		})
	}

	// Convert bundle.Events ([]string) to []AnalyzeEvent
	var events []AnalyzeEvent
	if bundle.Events != nil {
		for _, e := range bundle.Events {
			events = append(events, AnalyzeEvent{Reason: e})
		}
	} else {
		events = []AnalyzeEvent{}
	}

	// -------- EXISTING PREPROCESS RESPONSE (UNCHANGED) --------
	preprocessResponse := AnalyzeResponse{
		Bundle: AnalyzeBundle{
			ID:                   bundle.ID,
			WindowStart:          bundle.WindowStart,
			WindowEnd:            bundle.WindowEnd,
			RootService:          "",
			AffectedServices:     bundle.AffectedServices,
			LogPatterns:          patterns,
			Events:               events,
			Metrics: AnalyzeMetrics{
				LatencyZ:   bundle.Metrics.LatencyZ,
				ErrorRateZ: bundle.Metrics.ErrorRateZ,
			},
			DependencyGraph:      bundle.DependencyGraph,
			DerivedRootCauseHint: bundle.DerivedRootCauseHint,
		},
		UseRag: true,
		TopK:   5,
	}

	// -------- CALL /ai/analyze WITH SAME BODY --------
	var analyzeRespRaw json.RawMessage

	reqBody, _ := json.Marshal(preprocessResponse)
	req, err := http.NewRequest(
		http.MethodPost,
		"http://3.19.71.20:8000/ai/analyze",
		strings.NewReader(string(reqBody)),
	)
	if err != nil {
		// Request construction failed — return an error payload (non-null)
		errObj := map[string]string{"error": fmt.Sprintf("request creation failed: %s", err.Error())}
		b, _ := json.Marshal(errObj)
		analyzeRespRaw = json.RawMessage(b)
		fmt.Printf("analyze request creation failed: %v\n", err)
	} else {
		req.Header.Set("Content-Type", "application/json")
		// Wait up to 2 minutes for the analyze service to respond
		client := &http.Client{Timeout: 2 * time.Minute}

		// Perform the request and wait for completion (blocking)
		resp, err := client.Do(req)
		if err != nil {
			// Network or other error — return an error payload (non-null)
			errObj := map[string]string{"error": fmt.Sprintf("analyze request failed: %s", err.Error())}
			b, _ := json.Marshal(errObj)
			analyzeRespRaw = json.RawMessage(b)
			fmt.Printf("analyze request failed: %v\n", err)
		} else {
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if len(body) == 0 {
				analyzeRespRaw = json.RawMessage([]byte("{}"))
			} else {
				analyzeRespRaw = json.RawMessage(body)
			}
		}
	}

	// -------- COMBINED RESPONSE --------
	finalResponse := PreprocessCombinedResponse{
		PreprocessResponse: preprocessResponse,
		AnalyzeResponse:    analyzeRespRaw,
	}

	w.Header().Set("Content-Type", "application/json")
	// Use json.Marshal and explicit write so we can fallback and log on failure
	respBytes, err := json.Marshal(finalResponse)
	if err != nil {
		fmt.Printf("failed to marshal finalResponse: %v\n", err)
		respBytes = []byte(`{"preprocess_response":{"bundle":{"id":""},"use_rag":true,"top_k":5},"analyze_response":{"error":"marshal failed"}}`)
	}
	if _, err := w.Write(respBytes); err != nil {
		fmt.Printf("failed to write /logs/preprocess response: %v\n", err)
	}
}


// helper to safely convert slice of any to []string
func toStringSlice(src interface{}) []string {
	var out []string
	if src == nil {
		return out
	}
	switch v := src.(type) {
	case []string:
		return v
	case []interface{}:
		for _, s := range v {
			out = append(out, fmt.Sprintf("%v", s))
		}
	}
	return out
}

//
// ================= MAIN =================
//

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "")
	cfg := flag.String("config", "", "")
	flag.Parse()

	if *cfg != "" {
		b, _ := os.ReadFile(*cfg)
		yaml.Unmarshal(b, &globalConfig)
	}

	if globalConfig == nil {
		globalConfig = &Config{}
	}
	if globalConfig.Server == nil {
		globalConfig.Server = &ServerConfig{DefaultLines: 100, MaxLines: 1000}
	}

	http.HandleFunc("/logs", logsHandler)
	http.HandleFunc("/stream/ingest", streamIngestHandler)
	http.HandleFunc("/stream/status", streamStatusHandler)
	http.HandleFunc("/stream/live", streamLiveHandler)
	http.HandleFunc("/logs/preprocess", preprocessHandler)

	fmt.Println("Agent running on", *addr)
	http.ListenAndServe(*addr, nil)
}
