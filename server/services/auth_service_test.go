package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const testJWTSecret = "test-secret-key-for-auth-service"

// preHashPassword generates a bcrypt hash at cost 4 (fast for tests).
// Tests that need to verify password comparison use this instead of cost 12.
func preHashPassword(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("failed to pre-hash password: %v", err)
	}
	return string(hash)
}

func newTestAuthService(userRepo *testutil.MockUserRepo, sessionRepo *testutil.MockSessionRepo) AuthService {
	return NewAuthService(userRepo, sessionRepo, &testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{}, testJWTSecret, 15, 7)
}

func TestRegister(t *testing.T) {
	tests := []struct {
		name      string
		req       *models.CreateUserRequest
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
		errIs     error
	}{
		{
			name: "should register successfully with valid request",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: "password123",
				Email:    "test@example.com",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.IsEmailPlatformBannedFn = func(ctx context.Context, email string) (bool, error) {
					return false, nil
				}
				ur.CreateFn = func(ctx context.Context, user *models.User) error {
					// Verify bcrypt hash was generated
					if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte("password123")); err != nil {
						t.Errorf("password hash does not match: %v", err)
					}
					user.ID = "user-1"
					return nil
				}
			},
			wantErr: false,
		},
		{
			name: "should fail when username is too short",
			req: &models.CreateUserRequest{
				Username: "ab",
				Password: "password123",
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
		{
			name: "should fail when password is too short",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: "short",
			},
			wantErr: true,
			errIs:   pkg.ErrBadRequest,
		},
		{
			name: "should fail when email is platform banned",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: "password123",
				Email:    "banned@example.com",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.IsEmailPlatformBannedFn = func(ctx context.Context, email string) (bool, error) {
					return true, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrForbidden,
		},
		{
			name: "should fail when username already exists",
			req: &models.CreateUserRequest{
				Username: "existing",
				Password: "password123",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.CreateFn = func(ctx context.Context, user *models.User) error {
					return errors.New("UNIQUE constraint failed: users.username")
				}
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			tokens, err := svc.Register(context.Background(), tc.req)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tokens.AccessToken == "" {
				t.Error("expected non-empty access token")
			}
			if tokens.RefreshToken == "" {
				t.Error("expected non-empty refresh token")
			}
		})
	}
}

func TestLogin(t *testing.T) {
	hashedPassword := preHashPassword(t, "password123")

	tests := []struct {
		name      string
		req       *models.LoginRequest
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
		errIs     error
	}{
		{
			name: "should login successfully with correct credentials",
			req:  &models.LoginRequest{Username: "testuser", Password: "password123"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						Username:     "testuser",
						PasswordHash: hashedPassword,
						Status:       models.UserStatusOffline,
					}, nil
				}
			},
			wantErr: false,
		},
		{
			name: "should return unauthorized when password is wrong",
			req:  &models.LoginRequest{Username: "testuser", Password: "wrongpassword"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						Username:     "testuser",
						PasswordHash: hashedPassword,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name: "should return unauthorized when user not found",
			req:  &models.LoginRequest{Username: "nonexistent", Password: "password123"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return nil, pkg.ErrNotFound
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name: "should return forbidden when user is platform banned",
			req:  &models.LoginRequest{Username: "banned", Password: "password123"},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.GetByUsernameFn = func(ctx context.Context, username string) (*models.User, error) {
					return &models.User{
						ID:               "user-2",
						Username:         "banned",
						PasswordHash:     hashedPassword,
						IsPlatformBanned: true,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			tokens, err := svc.Login(context.Background(), tc.req)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tokens.AccessToken == "" {
				t.Error("expected non-empty access token")
			}
			if tokens.RefreshToken == "" {
				t.Error("expected non-empty refresh token")
			}
			if tokens.User.Username != "testuser" {
				t.Errorf("expected username 'testuser', got %q", tokens.User.Username)
			}
			if tokens.User.PasswordHash != "" {
				t.Error("password hash should be cleared from returned user")
			}
		})
	}
}

func TestRefreshToken(t *testing.T) {
	tests := []struct {
		name      string
		token     string
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
		errIs     error
	}{
		{
			name:  "should refresh successfully with valid token",
			token: "valid-refresh-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:           "session-1",
						UserID:       "user-1",
						RefreshToken: token,
						ExpiresAt:    time.Now().Add(24 * time.Hour),
					}, nil
				}
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:       "user-1",
						Username: "testuser",
					}, nil
				}
			},
			wantErr: false,
		},
		{
			name:  "should return unauthorized when token not found",
			token: "invalid-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return nil, pkg.ErrNotFound
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:  "should return unauthorized when token is expired",
			token: "expired-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:           "session-1",
						UserID:       "user-1",
						RefreshToken: token,
						ExpiresAt:    time.Now().Add(-1 * time.Hour),
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:  "should return forbidden when user is banned",
			token: "banned-user-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:           "session-2",
						UserID:       "user-2",
						RefreshToken: token,
						ExpiresAt:    time.Now().Add(24 * time.Hour),
					}, nil
				}
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:               "user-2",
						Username:         "banned",
						IsPlatformBanned: true,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			tokens, err := svc.RefreshToken(context.Background(), tc.token)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tokens.AccessToken == "" {
				t.Error("expected non-empty access token")
			}
			if tokens.RefreshToken == "" {
				t.Error("expected non-empty refresh token")
			}
		})
	}
}

func TestValidateAccessToken(t *testing.T) {
	svc := newTestAuthService(&testutil.MockUserRepo{}, &testutil.MockSessionRepo{})

	// Generate a valid token for test cases
	validClaims := &models.TokenClaims{
		UserID:   "user-1",
		Username: "testuser",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "mqvi",
		},
	}
	validToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("failed to create test token: %v", err)
	}

	// Token signed with wrong key
	wrongKeyToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims).SignedString([]byte("wrong-secret"))
	if err != nil {
		t.Fatalf("failed to create wrong-key token: %v", err)
	}

	// Token signed with RSA (wrong signing method) — use none algorithm workaround
	rsaClaims := &models.TokenClaims{
		UserID:   "user-1",
		Username: "testuser",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
		},
	}
	// Manually craft a token with "none" algorithm header to test signing method check
	noneToken := jwt.NewWithClaims(jwt.SigningMethodNone, rsaClaims)
	noneTokenStr, err := noneToken.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("failed to create none-signed token: %v", err)
	}

	tests := []struct {
		name    string
		token   string
		wantErr bool
		errIs   error
		checkFn func(t *testing.T, claims *models.TokenClaims)
	}{
		{
			name:    "should return claims for valid token",
			token:   validToken,
			wantErr: false,
			checkFn: func(t *testing.T, claims *models.TokenClaims) {
				if claims.UserID != "user-1" {
					t.Errorf("expected user_id 'user-1', got %q", claims.UserID)
				}
				if claims.Username != "testuser" {
					t.Errorf("expected username 'testuser', got %q", claims.Username)
				}
			},
		},
		{
			name:    "should return unauthorized for token signed with wrong key",
			token:   wrongKeyToken,
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:    "should return unauthorized for wrong signing method",
			token:   noneTokenStr,
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
		{
			name:    "should return unauthorized for garbage token",
			token:   "not-a-jwt-token",
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := svc.ValidateAccessToken(tc.token)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.checkFn != nil {
				tc.checkFn(t, claims)
			}
		})
	}
}

// TestValidateAccessToken_NoDBReadForBannedUser pins down the B2
// optimization: ValidateAccessToken is now JWT-only, NO DB read.
// The IsPlatformBanned + TokenVersion checks moved to:
//   - HTTP: middleware/auth.go AuthMiddleware.Require (against userCache)
//   - WS:   ws/handler.go HandleConnection (against the user row it
//     already fetches for username/avatar)
//
// This test would have failed under the prior implementation that
// inlined a userRepo.GetByID lookup inside ValidateAccessToken: the
// mock here returns IsPlatformBanned=true, but the validator must
// still return the parsed claims because the gate is no longer here.
func TestValidateAccessToken_NoDBReadForBannedUser(t *testing.T) {
	validClaims := &models.TokenClaims{
		UserID:   "user-banned",
		Username: "banned",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "mqvi",
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims).
		SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("failed to create test token: %v", err)
	}

	// Sentinel: if anyone reintroduces a DB read inside
	// ValidateAccessToken, this fn fires and fails the test.
	repoCalled := false
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
			repoCalled = true
			return &models.User{
				ID:               "user-banned",
				Username:         "banned",
				IsPlatformBanned: true,
			}, nil
		},
	}
	svc := newTestAuthService(userRepo, &testutil.MockSessionRepo{})

	claims, err := svc.ValidateAccessToken(token)
	if err != nil {
		t.Fatalf("ValidateAccessToken should pass JWT-only check, got: %v", err)
	}
	if claims.UserID != "user-banned" {
		t.Fatalf("expected UserID=user-banned, got %q", claims.UserID)
	}
	if repoCalled {
		t.Fatal("ValidateAccessToken must NOT call userRepo.GetByID — the DB check moved to AuthMiddleware / WS handler")
	}
}

// TestValidateAccessToken_NoDBReadForBumpedVersion is the TokenVersion
// twin of the test above. Same rationale: the version gate now lives
// in the middleware (HTTP) and the WS upgrade path. ValidateAccessToken
// only parses the JWT.
func TestValidateAccessToken_NoDBReadForBumpedVersion(t *testing.T) {
	validClaims := &models.TokenClaims{
		UserID:       "user-bumped",
		Username:     "bumped",
		TokenVersion: 0,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "mqvi",
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims).
		SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("failed to create test token: %v", err)
	}

	repoCalled := false
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
			repoCalled = true
			return &models.User{
				ID:           "user-bumped",
				Username:     "bumped",
				TokenVersion: 1, // bumped (e.g. by PlatformBan or "logout-all")
			}, nil
		},
	}
	svc := newTestAuthService(userRepo, &testutil.MockSessionRepo{})

	claims, err := svc.ValidateAccessToken(token)
	if err != nil {
		t.Fatalf("ValidateAccessToken should pass JWT-only check, got: %v", err)
	}
	if claims.TokenVersion != 0 {
		t.Fatalf("expected TokenVersion=0 (from JWT), got %d", claims.TokenVersion)
	}
	if repoCalled {
		t.Fatal("ValidateAccessToken must NOT call userRepo.GetByID — version gate moved to AuthMiddleware / WS handler")
	}
}

// TestGenerateMediaToken pins the shape of the media-scoped token that the
// hichat_media cookie carries: same signing key/method as the access token
// (so ValidateAccessToken accepts it) but marked scope=media and given the
// media TTL rather than the ~15min access TTL.
//
// The TTL alignment is half the bug this fixes: the cookie used to outlive
// the access token inside it by weeks, so an idle tab kept presenting a
// long-expired credential and every image 401'd.
func TestGenerateMediaToken(t *testing.T) {
	svc := newTestAuthService(&testutil.MockUserRepo{}, &testutil.MockSessionRepo{})

	issuedAt := time.Now()
	token, err := svc.GenerateMediaToken("user-media")
	if err != nil {
		t.Fatalf("GenerateMediaToken: %v", err)
	}
	if token == "" {
		t.Fatal("GenerateMediaToken returned an empty token")
	}

	// Must validate through the ordinary validator — the media cookie is
	// verified by handlers.UploadDownloadHandler via the same entry point.
	claims, err := svc.ValidateAccessToken(token)
	if err != nil {
		t.Fatalf("media token must pass ValidateAccessToken, got: %v", err)
	}

	if claims.UserID != "user-media" {
		t.Errorf("UserID = %q, want %q", claims.UserID, "user-media")
	}
	if claims.Scope != models.TokenScopeMedia {
		t.Errorf("Scope = %q, want %q", claims.Scope, models.TokenScopeMedia)
	}
	if claims.Issuer != "mqvi" {
		t.Errorf("Issuer = %q, want %q", claims.Issuer, "mqvi")
	}
	if claims.ExpiresAt == nil {
		t.Fatal("media token must carry an expiry")
	}

	// Expiry lands at issue time + MediaTokenTTL, with slack for the clock
	// ticking between our issuedAt sample and the one inside the service.
	wantExp := issuedAt.Add(MediaTokenTTL)
	if delta := claims.ExpiresAt.Sub(wantExp); delta > time.Minute || delta < -time.Minute {
		t.Errorf("ExpiresAt = %v, want ~%v (delta %v)", claims.ExpiresAt.Time, wantExp, delta)
	}

	// The cookie Max-Age is derived from this constant; if someone retunes
	// the TTL they must retune the cookie in handlers/auth.go with it.
	if MediaTokenTTL != 7*24*time.Hour {
		t.Errorf("MediaTokenTTL = %v, want 7 days (keep handlers.mediaCookieTTL in sync)", MediaTokenTTL)
	}
}

// TestGenerateTokens_AccessTokenHasEmptyScope is the regression pin for the
// other side of the scope gate. AuthMiddleware and the WS upgrade path now
// reject any token with a non-empty scope; if the access-token generator
// ever started stamping a scope, every authenticated request would 401.
func TestGenerateTokens_AccessTokenHasEmptyScope(t *testing.T) {
	userRepo := &testutil.MockUserRepo{
		IsEmailPlatformBannedFn: func(_ context.Context, _ string) (bool, error) { return false, nil },
		CreateFn: func(_ context.Context, user *models.User) error {
			user.ID = "user-1"
			return nil
		},
	}
	svc := newTestAuthService(userRepo, &testutil.MockSessionRepo{})

	tokens, err := svc.Register(context.Background(), &models.CreateUserRequest{
		Username: "scopeless",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	claims, err := svc.ValidateAccessToken(tokens.AccessToken)
	if err != nil {
		t.Fatalf("ValidateAccessToken: %v", err)
	}
	if claims.Scope != "" {
		t.Errorf("access token Scope = %q, want empty — a scoped access token would be rejected by AuthMiddleware", claims.Scope)
	}
}

func TestChangePassword(t *testing.T) {
	hashedPassword := preHashPassword(t, "currentpass1")

	tests := []struct {
		name        string
		userID      string
		currentPass string
		newPass     string
		setupRepo   func(*testutil.MockUserRepo)
		wantErr     bool
		errIs       error
	}{
		{
			name:        "should change password successfully with correct current password",
			userID:      "user-1",
			currentPass: "currentpass1",
			newPass:     "newpassword1",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						PasswordHash: hashedPassword,
					}, nil
				}
				ur.UpdatePasswordFn = func(ctx context.Context, userID string, newHash string) error {
					if err := bcrypt.CompareHashAndPassword([]byte(newHash), []byte("newpassword1")); err != nil {
						t.Errorf("new password hash does not match: %v", err)
					}
					return nil
				}
			},
			wantErr: false,
		},
		{
			name:        "should fail when new password is too short",
			userID:      "user-1",
			currentPass: "currentpass1",
			newPass:     "short",
			wantErr:     true,
			errIs:       pkg.ErrBadRequest,
		},
		{
			name:        "should fail when current password is empty",
			userID:      "user-1",
			currentPass: "",
			newPass:     "newpassword1",
			wantErr:     true,
			errIs:       pkg.ErrBadRequest,
		},
		{
			name:        "should fail when current password is incorrect",
			userID:      "user-1",
			currentPass: "wrongpassword",
			newPass:     "newpassword1",
			setupRepo: func(ur *testutil.MockUserRepo) {
				ur.GetByIDFn = func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{
						ID:           "user-1",
						PasswordHash: hashedPassword,
					}, nil
				}
			},
			wantErr: true,
			errIs:   pkg.ErrUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo)
			}

			svc := newTestAuthService(userRepo, &testutil.MockSessionRepo{})
			err := svc.ChangePassword(context.Background(), tc.userID, tc.currentPass, tc.newPass)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errIs != nil && !errors.Is(err, tc.errIs) {
					t.Errorf("expected error wrapping %v, got: %v", tc.errIs, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestLogout(t *testing.T) {
	tests := []struct {
		name      string
		token     string
		setupRepo func(*testutil.MockUserRepo, *testutil.MockSessionRepo)
		wantErr   bool
	}{
		{
			name:  "should logout successfully",
			token: "valid-refresh-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return &models.Session{
						ID:     "session-1",
						UserID: "user-1",
					}, nil
				}
				var statusUpdated bool
				ur.UpdateStatusFn = func(ctx context.Context, userID string, status models.UserStatus) error {
					if status != models.UserStatusOffline {
						t.Errorf("expected status offline, got %v", status)
					}
					statusUpdated = true
					return nil
				}
				sr.DeleteByIDFn = func(ctx context.Context, id string) error {
					if !statusUpdated {
						t.Error("expected status update before session delete")
					}
					if id != "session-1" {
						t.Errorf("expected session id 'session-1', got %q", id)
					}
					return nil
				}
			},
			wantErr: false,
		},
		{
			name:  "should return nil when token not found",
			token: "nonexistent-token",
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				sr.GetByRefreshTokenFn = func(ctx context.Context, token string) (*models.Session, error) {
					return nil, pkg.ErrNotFound
				}
			},
			wantErr: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{}
			sessionRepo := &testutil.MockSessionRepo{}
			if tc.setupRepo != nil {
				tc.setupRepo(userRepo, sessionRepo)
			}

			svc := newTestAuthService(userRepo, sessionRepo)
			err := svc.Logout(context.Background(), tc.token)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
