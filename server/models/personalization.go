package models

type PersonalizationRecommendations struct {
	Enabled bool     `json:"enabled"`
	Items   []string `json:"items"`
}
