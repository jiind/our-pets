package model

type GatheringActivity struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Action    string    `json:"action"`
	Actor     Sender    `json:"actor"`
	Gathering Gathering `json:"gathering"`
	CreatedAt int64     `json:"createdAt"`
	ExpiresAt int64     `json:"expiresAt"`
}
