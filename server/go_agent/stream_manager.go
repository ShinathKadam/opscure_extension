package main

import (
	"encoding/json"
	"sync"
	"time"
)

//
// ===================== PLACEHOLDERS / DEPENDENCIES =====================
//

type RawLog struct {
	Data map[string]interface{}
}

type CorrelationBundle struct {
	Sequence []RawLog
	Metadata map[string]interface{}
}

func (c *CorrelationBundle) ModelDumpJSON() string {
	b, _ := json.Marshal(c)
	return string(b)
}

type LogPreprocessor struct {
	Parser  *LogParser
	Miner   *PatternMiner
	Factory *BundleFactory
}

func NewLogPreprocessor() *LogPreprocessor {
	return &LogPreprocessor{
		Parser:  &LogParser{},
		Miner:   &PatternMiner{},
		Factory: &BundleFactory{},
	}
}

type LogParser struct{}

func (p *LogParser) ParseLogs(logs []map[string]interface{}) ([]RawLog, error) {
	var parsed []RawLog
	for _, l := range logs {
		parsed = append(parsed, RawLog{Data: l})
	}
	return parsed, nil
}

type PatternMiner struct{}

func (m *PatternMiner) MinePatterns(logs []RawLog) []string {
	return []string{"pattern1"}
}

type BundleFactory struct{}

func (f *BundleFactory) CreateBundle(logs []RawLog, patterns []string) *CorrelationBundle {
	return &CorrelationBundle{
		Sequence: logs,
		Metadata: map[string]interface{}{
			"patterns": patterns,
		},
	}
}

//
// ===================== CONFIG & STATS =====================
//

type StreamConfig struct {
	MaxLogsPerSecond     int
	MaxBufferSize        int
	MaxTokensPerRun      int
	MaxStreamDurationMin float64
	MinStreamDurationMin float64
}

func DefaultStreamConfig() StreamConfig {
	return StreamConfig{
		MaxLogsPerSecond:     50,
		MaxBufferSize:        200,
		MaxTokensPerRun:      6000,
		MaxStreamDurationMin: 60,
		MinStreamDurationMin: 15,
	}
}

type StreamStats struct {
	StartTime         time.Time
	TotalLogsIngested int
	BufferFlushCount  int
	DroppedLogs       int
}

//
// ===================== STREAM MANAGER =====================
//

type StreamManager struct {
	Config StreamConfig
	Buffer []RawLog
	Stats  StreamStats

	Preprocessor *LogPreprocessor

	checkWindowStart time.Time
	logsInWindow     int

	// 🔹 ADDITIVE: subscribers for SSE
	subscribers map[chan *CorrelationBundle]struct{}
	mu          sync.Mutex
}

func NewStreamManager(config StreamConfig) *StreamManager {
	return &StreamManager{
		Config:           config,
		Buffer:           []RawLog{},
		Stats:            StreamStats{StartTime: time.Now()},
		Preprocessor:     NewLogPreprocessor(),
		checkWindowStart: time.Now(),
		logsInWindow:     0,
		subscribers:      make(map[chan *CorrelationBundle]struct{}),
	}
}

//
// ===================== INGEST =====================
//

func (s *StreamManager) Ingest(logDict map[string]interface{}) bool {

	if s.IsExpired() {
		return false
	}

	now := time.Now()
	if now.Sub(s.checkWindowStart) >= time.Second {
		s.checkWindowStart = now
		s.logsInWindow = 0
	}

	if s.logsInWindow >= s.Config.MaxLogsPerSecond {
		s.Stats.DroppedLogs++
		return false
	}

	parsed, err := s.Preprocessor.Parser.ParseLogs([]map[string]interface{}{logDict})
	if err != nil {
		s.Stats.DroppedLogs++
		return false
	}

	s.Buffer = append(s.Buffer, parsed[0])
	s.logsInWindow++
	s.Stats.TotalLogsIngested++

	return true
}

func (s *StreamManager) ShouldFlush() bool {
	return len(s.Buffer) >= s.Config.MaxBufferSize
}

func (s *StreamManager) IsExpired() bool {
	elapsedMinutes := time.Since(s.Stats.StartTime).Minutes()
	return elapsedMinutes > s.Config.MaxStreamDurationMin
}

//
// ===================== FLUSH =====================
//

func (s *StreamManager) Flush() *CorrelationBundle {

	if len(s.Buffer) == 0 {
		return nil
	}

	patterns := s.Preprocessor.Miner.MinePatterns(s.Buffer)
	bundle := s.Preprocessor.Factory.CreateBundle(s.Buffer, patterns)

	estimatedTokens := s.estimateTokens(bundle)
	if estimatedTokens > s.Config.MaxTokensPerRun {
		ratio := float64(s.Config.MaxTokensPerRun) / float64(estimatedTokens)
		newLen := int(float64(len(bundle.Sequence)) * ratio * 0.9)
		if newLen < 0 {
			newLen = 0
		}
		bundle.Sequence = bundle.Sequence[:newLen]
		bundle.Metadata["truncated"] = true
		bundle.Metadata["original_token_est"] = estimatedTokens
	}

	s.Buffer = []RawLog{}
	s.Stats.BufferFlushCount++

	// 🔹 ADDITIVE: publish to SSE subscribers
	s.publish(bundle)

	return bundle
}

func (s *StreamManager) estimateTokens(bundle *CorrelationBundle) int {
	jsonStr := bundle.ModelDumpJSON()
	return len(jsonStr) / 4
}

//
// ===================== SSE SUPPORT (ADDITIVE) =====================
//

func (s *StreamManager) Subscribe() chan *CorrelationBundle {
	ch := make(chan *CorrelationBundle, 1)
	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()
	return ch
}

func (s *StreamManager) Unsubscribe(ch chan *CorrelationBundle) {
	s.mu.Lock()
	delete(s.subscribers, ch)
	close(ch)
	s.mu.Unlock()
}

func (s *StreamManager) publish(bundle *CorrelationBundle) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subscribers {
		select {
		case ch <- bundle:
		default:
		}
	}
}
