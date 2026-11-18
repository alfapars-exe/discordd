package middleware

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/cache"
	"time"
)

// AuthUserCache owns cached identities independently of the middleware that
// validates requests. Composition can share this owner with credential writers.
type AuthUserCache struct {
	entries *cache.TTLCache[string, *models.User]
}

func NewAuthUserCache() *AuthUserCache {
	return &AuthUserCache{entries: cache.New[string, *models.User](userCacheTTL, time.Minute)}
}
func (c *AuthUserCache) Get(id string) (*models.User, bool) { return c.entries.Get(id) }
func (c *AuthUserCache) Set(id string, user *models.User)   { c.entries.Set(id, user) }
func (c *AuthUserCache) InvalidateUser(id string)           { c.entries.Delete(id) }
func (c *AuthUserCache) Close()                             { c.entries.Close() }
