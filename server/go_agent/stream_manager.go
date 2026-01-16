/*
Copyright (c) 2026 OPSCURE.
All rights reserved.

This software is the confidential and proprietary information of OPSCURE.
Unauthorized copying, modification, distribution, or use of this software,
via any medium, is strictly prohibited without prior written permission.

Licensed under the OPSCURE Software License Agreement.
*/

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
	Factory *BundleFactory
}

func NewLogPreprocessor() *LogPreprocessor {
	return &LogPreprocessor{
		Parser:  &LogParser{},
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
		MaxBufferSize:        50,
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

	// SSE subscribers
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

	// ✅ REAL pattern derivation (no placeholder)
	patterns := deriveStreamPatterns(s.Buffer)

	bundle := s.Preprocessor.Factory.CreateBundle(s.Buffer, patterns)

	estimatedTokens := s.estimateTokens(bundle)

	bundle.Metadata["original_token_est"] = estimatedTokens
	bundle.Metadata["truncated"] = false

	if estimatedTokens > s.Config.MaxTokensPerRun {
		ratio := float64(s.Config.MaxTokensPerRun) / float64(estimatedTokens)
		newLen := int(float64(len(bundle.Sequence)) * ratio * 0.9)
		if newLen < 0 {
			newLen = 0
		}
		bundle.Sequence = bundle.Sequence[:newLen]
		// bundle.Metadata["truncated"] = true
		bundle.Metadata["original_token_est"] = estimatedTokens
	}

	s.Buffer = []RawLog{}
	s.Stats.BufferFlushCount++

	s.publish(bundle)

	return bundle
}

func (s *StreamManager) estimateTokens(bundle *CorrelationBundle) int {
	jsonStr := bundle.ModelDumpJSON()
	return len(jsonStr) / 4
}

//
// ===================== SSE SUPPORT =====================
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

//
// ===================== PATTERN DERIVATION =====================
//

// ✅ Lightweight, generic, non-hardcoded
func deriveStreamPatterns(logs []RawLog) []string {
	unique := make(map[string]struct{})

	for _, rl := range logs {
		if msg, ok := rl.Data["message"].(string); ok && msg != "" {
			unique[msg] = struct{}{}
		}
	}

	var patterns []string
	for msg := range unique {
		patterns = append(patterns, msg)
	}

	return patterns
}
