package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type showcaseLinksRepo struct{ doc models.ProfileShowcase }

func (r *showcaseLinksRepo) Get(context.Context, string, string) (*models.ProfileShowcase, error) {
	out := r.doc
	out.Links = append([]models.ProfileLink{}, r.doc.Links...)
	return &out, nil
}
func (r *showcaseLinksRepo) Put(_ context.Context, _, _ string, doc *models.ProfileShowcase, _ int64) (*models.ProfileShowcase, error) {
	r.doc = *doc
	return r.Get(context.Background(), "", "")
}

type showcaseAllowedAudience struct{}

func (showcaseAllowedAudience) CanView(context.Context, string, string) (bool, error) {
	return true, nil
}

func TestProfileShowcaseManualLinkVisibility(t *testing.T) {
	ctx := context.Background()
	repo := &showcaseLinksRepo{}
	service := NewProfileShowcaseService(repo, nil, showcaseAllowedAudience{})
	doc := &models.ProfileShowcase{Links: []models.ProfileLink{
		{ID: "hidden", Label: "Hidden", URL: "https://example.org", Visible: false},
		{ID: "visible", Label: "Public", URL: "https://example.com", Visible: true},
	}}
	if _, err := service.Put(ctx, "owner", "", doc, 0); err != nil {
		t.Fatal(err)
	}
	public, err := service.GetPublic(ctx, "viewer", "owner", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(public.Links) != 1 || public.Links[0].ID != "visible" {
		t.Fatalf("hidden link exposed: %+v", public.Links)
	}
	owner, err := service.Get(ctx, "owner", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(owner.Links) != 2 || owner.Links[0].Visible {
		t.Fatalf("owner cannot edit hidden links: %+v", owner.Links)
	}
	owner.Links[1].Visible = false
	if _, err := service.Put(ctx, "owner", "", owner, 1); err != nil {
		t.Fatal(err)
	}
	public, err = service.GetPublic(ctx, "viewer", "owner", "")
	if err != nil {
		t.Fatal(err)
	}
	if public.Links == nil || len(public.Links) != 0 {
		t.Fatalf("all hidden links must return an empty array: %+v", public.Links)
	}
}
