package main

import (
	"errors"
	"sort"
	"time"
)

type RawLogGo struct {
	Timestamp  string
	Level      string
	Service    string
	Pod        *string
	Message    string
	ErrorClass *string
}

type LogPatternGo struct {
	Pattern         string
	Count           int
	FirstOccurrence string
	LastOccurrence  string
	ErrorClass      *string
}

type SequenceItemGo struct {
	Timestamp     string
	Type          string
	Message       string
	SequenceIndex int
}

type MetricsGo struct {
	ErrorRateZ float64
	LatencyZ   float64
}

type CorrelationBundleGo struct {
	ID                   string // ✅ ADDED (NO LOGIC CHANGE)
	WindowStart          string
	WindowEnd            string
	RootService          *string
	AffectedServices     []string
	LogPatterns          []LogPatternGo
	Events               []string
	Metrics              MetricsGo
	DependencyGraph      []string
	Sequence             []SequenceItemGo
	DerivedRootCauseHint string
}

type LogParserGo struct{}

func (p *LogParserGo) ParseLogs(rawData []map[string]interface{}) ([]RawLogGo, error) {
	if rawData == nil {
		return nil, errors.New("rawData is nil")
	}

	var parsedLogs []RawLogGo
	for _, entry := range rawData {
		timestamp := time.Now().UTC().Format(time.RFC3339)
		if v, ok := entry["timestamp"].(string); ok && v != "" {
			timestamp = v
		}

		level := "INFO"
		if v, ok := entry["level"].(string); ok && v != "" {
			level = v
		}

		service := "unknown"
		if v, ok := entry["service"].(string); ok && v != "" {
			service = v
		}

		message := ""
		if v, ok := entry["message"].(string); ok {
			message = v
		}

		parsedLogs = append(parsedLogs, RawLogGo{
			Timestamp: timestamp,
			Level:     level,
			Service:   service,
			Message:   message,
		})
	}

	sort.Slice(parsedLogs, func(i, j int) bool {
		return parsedLogs[i].Timestamp < parsedLogs[j].Timestamp
	})

	return parsedLogs, nil
}

type LogPatternMinerGo struct{}

func (m *LogPatternMinerGo) MinePatterns(logs []RawLogGo) []LogPatternGo {
	patternMap := make(map[string]LogPatternGo)

	for _, log := range logs {
		p := patternMap[log.Message]
		if p.Pattern == "" {
			p.Pattern = log.Message
			p.FirstOccurrence = log.Timestamp
		}
		p.Count++
		p.LastOccurrence = log.Timestamp
		patternMap[log.Message] = p
	}

	var patterns []LogPatternGo
	for _, p := range patternMap {
		patterns = append(patterns, p)
	}
	return patterns
}

type BundleFactoryGo struct{}

func (f *BundleFactoryGo) CreateBundle(logs []RawLogGo, patterns []LogPatternGo) (*CorrelationBundleGo, error) {
	if len(logs) == 0 {
		return nil, errors.New("empty logs")
	}

	windowStart := logs[0].Timestamp
	windowEnd := logs[len(logs)-1].Timestamp

	serviceSet := map[string]struct{}{}
	for _, l := range logs {
		serviceSet[l.Service] = struct{}{}
	}

	var services []string
	for s := range serviceSet {
		services = append(services, s)
	}

	return &CorrelationBundleGo{
		WindowStart:          windowStart,
		WindowEnd:            windowEnd,
		AffectedServices:     services,
		LogPatterns:          patterns,
		Metrics:              MetricsGo{},
		DependencyGraph:      services,
		DerivedRootCauseHint: "Unknown issue",
	}, nil
}

type LogPreprocessorFullGo struct {
	Parser  *LogParserGo
	Miner   *LogPatternMinerGo
	Factory *BundleFactoryGo
}

func NewLogPreprocessorFullGo() *LogPreprocessorFullGo {
	return &LogPreprocessorFullGo{
		Parser:  &LogParserGo{},
		Miner:   &LogPatternMinerGo{},
		Factory: &BundleFactoryGo{},
	}
}

func (p *LogPreprocessorFullGo) Process(rawData []map[string]interface{}, bundleID string) (*CorrelationBundleGo, error) {
	logs, err := p.Parser.ParseLogs(rawData)
	if err != nil {
		return nil, err
	}
	patterns := p.Miner.MinePatterns(logs)

	b, err := p.Factory.CreateBundle(logs, patterns)
	if err != nil {
		return nil, err
	}

	b.ID = bundleID // ✅ PROPAGATE ID
	return b, nil
}
