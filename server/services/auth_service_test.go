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

// revokeSpy records everything revokeAllSessions fans out to — session
// deletion (called TWICE per the BULGU 2 mitigation: once before the
// token_version bump, once after — see revokeAllSessions), the token_version
// bump, the auth-cache invalidation, and the WebSocket + voice disconnect —
// so ChangePassword / ResetPassword / LogoutAllDevices tests can assert the
// full guard fired for the right userID, and that a rejected/invalid request
// touches none of it. The failDeleteSessions / failBumpVersion toggles let a
// test prove the best-effort contract: one sub-step failing must not stop
// the rest.
type revokeSpy struct {
	deletedSessions   []string
	bumpedVersions    []string
	disconnectedUsers []string
	inval             *adminInvalStub
	voiceKit          *testutil.MockVoiceDisconnecter

	failDeleteSessions bool
	failBumpVersion    bool
}

func (s *revokeSpy) invalidatedCache() []string { return s.inval.invalidated }

// newRevokeHarness builds an AuthService with every revokeAllSessions
// collaborator wired to the returned *revokeSpy. resetRepo is a parameter
// (rather than a fixed empty mock) so ResetPassword tests can control the
// token lookup while still getting the same revocation observability.
func newRevokeHarness(userRepo *testutil.MockUserRepo, sessionRepo *testutil.MockSessionRepo, resetRepo *testutil.MockResetRepo) (AuthService, *revokeSpy) {
	spy := &revokeSpy{inval: &adminInvalStub{}, voiceKit: &testutil.MockVoiceDisconnecter{}}

	sessionRepo.DeleteByUserIDFn = func(_ context.Context, userID string) error {
		spy.deletedSessions = append(spy.deletedSessions, userID)
		if spy.failDeleteSessions {
			return errors.New("delete sessions failed")
		}
		return nil
	}
	userRepo.IncrementTokenVersionFn = func(_ context.Context, userID string) error {
		spy.bumpedVersions = append(spy.bumpedVersions, userID)
		if spy.failBumpVersion {
			return errors.New("bump token_version failed")
		}
		return nil
	}

	hub := &testutil.MockEventPublisher{
		DisconnectUserFn: func(userID string) {
			spy.disconnectedUsers = append(spy.disconnectedUsers, userID)
		},
	}

	svc := NewAuthService(userRepo, sessionRepo, resetRepo, hub, &testutil.MockEmailSender{}, testJWTSecret, 15, 7)
	svc.SetUserCacheInvalidator(spy.inval)
	svc.SetVoiceDisconnecter(spy.voiceKit)
	return svc, spy
}

// assertRevocationFired checks that revokeAllSessions' full fan-out ran
// exactly once for userID: the double DeleteByUserID sweep (pre-bump sweep +
// post-bump re-sweep — see the BULGU 2 comment on revokeAllSessions), the
// token_version bump, the auth-cache invalidation, and both the WebSocket and
// voice disconnects. Shared by the ChangePassword, ResetPassword, and
// LogoutAllDevices revocation tests, since a successful request on any of the
// three triggers the same revokeAllSessions fan-out.
func assertRevocationFired(t *testing.T, spy *revokeSpy, userID string) {
	t.Helper()
	if got := spy.deletedSessions; len(got) != 2 || got[0] != userID || got[1] != userID {
		t.Errorf("DeleteByUserID calls = %v, want [%s %s] (pre-bump sweep + post-bump re-sweep)", got, userID, userID)
	}
	if got := spy.bumpedVersions; len(got) != 1 || got[0] != userID {
		t.Errorf("IncrementTokenVersion calls = %v, want [%s]", got, userID)
	}
	if got := spy.invalidatedCache(); len(got) != 1 || got[0] != userID {
		t.Errorf("InvalidateUser calls = %v, want [%s]", got, userID)
	}
	if got := spy.disconnectedUsers; len(got) != 1 || got[0] != userID {
		t.Errorf("DisconnectUser calls = %v, want [%s]", got, userID)
	}
	if got := spy.voiceKit.DisconnectedIDs; len(got) != 1 || got[0] != userID {
		t.Errorf("voice DisconnectUser calls = %v, want [%s]", got, userID)
	}
}

// assertRevocationUntouched checks that none of revokeAllSessions'
// collaborators fired. Shared by the rejected/expired-input branches of the
// same three flows, where the fan-out must never run. context names the
// branch under test so a failure message says which one broke.
func assertRevocationUntouched(t *testing.T, spy *revokeSpy, context string) {
	t.Helper()
	if len(spy.deletedSessions) != 0 || len(spy.bumpedVersions) != 0 || len(spy.invalidatedCache()) != 0 || len(spy.disconnectedUsers) != 0 || len(spy.voiceKit.DisconnectedIDs) != 0 {
		t.Errorf("revocation collaborators must stay untouched %s: %+v", context, spy)
	}
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
				ur.CreateWithSessionFn = func(ctx context.Context, user *models.User, session *models.Session) error {
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
			// Email is optional at every layer — this pins Register()'s side
			// of that contract: a blank email must not block registration,
			// and must not even reach the ban-list check (there's nothing to
			// check), matching CreateUserRequest.Validate() and the client
			// form, which never require it.
			name: "should register successfully with no email, without checking the ban list",
			req: &models.CreateUserRequest{
				Username: "testuser",
				Password: "password123",
				Email:    "",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				ur.IsEmailPlatformBannedFn = func(ctx context.Context, email string) (bool, error) {
					t.Fatal("IsEmailPlatformBanned must not be called for a blank email")
					return false, nil
				}
				ur.CreateFn = func(ctx context.Context, user *models.User) error {
					if user.Email != nil {
						t.Errorf("expected user.Email to stay nil for a blank registration email, got %v", *user.Email)
					}
					user.ID = "user-1"
					return nil
				}
			},
			wantErr: false,
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
				ur.CreateWithSessionFn = func(ctx context.Context, user *models.User, session *models.Session) error {
					return errors.New("UNIQUE constraint failed: users.username")
				}
			},
			wantErr: true,
		},
		{
			name: "should fail when session creation fails after user row committed",
			req: &models.CreateUserRequest{
				Username: "testuser2",
				Password: "password123",
			},
			setupRepo: func(ur *testutil.MockUserRepo, sr *testutil.MockSessionRepo) {
				// Simulates the atomic CreateWithSession failing partway
				// through (e.g. the session INSERT trips an error inside the
				// transaction) — true row-level atomicity (user row rolled
				// back when the session insert fails) is verified separately
				// at the repository layer against a real DB, since a mock
				// can't observe SQL rollback.
				ur.CreateWithSessionFn = func(ctx context.Context, user *models.User, session *models.Session) error {
					return errors.New("db error: session insert failed")
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
		CreateWithSessionFn: func(_ context.Context, user *models.User, session *models.Session) error {
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

// TestChangePassword_RevokesAllSessions pins H-06: a successful password
// change must invalidate every session for the user (session rows,
// token_version, the HTTP auth cache, and any live WebSocket/voice
// connection) — not just bump token_version and leave the sessions table
// (and the socket) alive, which was the vacuous-guard bug. A rejected
// attempt (wrong current password) must touch none of it — the guard only
// fires once the password actually changes.
//
// DeleteByUserID is asserted at TWO calls (security review 2026-08-01,
// finding 2): revokeAllSessions re-sweeps session rows after the
// token_version bump to narrow the refresh-race window documented on
// revokeAllSessions. A mutation that drops the second sweep call would
// leave this assertion at 1 and must fail.
func TestChangePassword_RevokesAllSessions(t *testing.T) {
	hashedPassword := preHashPassword(t, "currentpass1")
	ctx := context.Background()

	newHarness := func() (AuthService, *revokeSpy, *testutil.MockUserRepo) {
		userRepo := &testutil.MockUserRepo{
			GetByIDFn: func(context.Context, string) (*models.User, error) {
				return &models.User{ID: "user-1", PasswordHash: hashedPassword}, nil
			},
		}
		svc, spy := newRevokeHarness(userRepo, &testutil.MockSessionRepo{}, &testutil.MockResetRepo{})
		return svc, spy, userRepo
	}

	t.Run("success revokes sessions (twice), bumps token_version, invalidates the cache, and disconnects the socket + voice", func(t *testing.T) {
		svc, spy, _ := newHarness()

		if err := svc.ChangePassword(ctx, "user-1", "currentpass1", "newpassword1"); err != nil {
			t.Fatalf("ChangePassword: %v", err)
		}

		assertRevocationFired(t, spy, "user-1")
	})

	t.Run("wrong current password touches none of the revocation collaborators", func(t *testing.T) {
		svc, spy, _ := newHarness()

		err := svc.ChangePassword(ctx, "user-1", "wrongpassword", "newpassword1")
		if !errors.Is(err, pkg.ErrUnauthorized) {
			t.Fatalf("err = %v, want ErrUnauthorized", err)
		}
		assertRevocationUntouched(t, spy, "on a rejected password change")
	})

	t.Run("a failing sub-step does not stop the others (best-effort)", func(t *testing.T) {
		svc, spy, _ := newHarness()
		spy.failDeleteSessions = true

		if err := svc.ChangePassword(ctx, "user-1", "currentpass1", "newpassword1"); err != nil {
			t.Fatalf("ChangePassword must still succeed when session deletion fails (best-effort): %v", err)
		}
		if len(spy.bumpedVersions) != 1 || len(spy.invalidatedCache()) != 1 || len(spy.disconnectedUsers) != 1 || len(spy.voiceKit.DisconnectedIDs) != 1 {
			t.Errorf("a failing DeleteByUserID must not stop the remaining revocation steps: %+v", spy)
		}
	})
}

// TestLogoutAllDevices pins the new POST /api/auth/logout-all backing
// method: it must revoke every session for userID (same fan-out as
// ChangePassword/ResetPassword, including the double session-delete sweep
// and the voice disconnect — security review 2026-08-01, findings 2 and 3)
// and mark the user offline, matching Logout's existing status-update
// behavior.
func TestLogoutAllDevices(t *testing.T) {
	ctx := context.Background()
	userRepo := &testutil.MockUserRepo{}
	svc, spy := newRevokeHarness(userRepo, &testutil.MockSessionRepo{}, &testutil.MockResetRepo{})

	var statusUpdated models.UserStatus
	userRepo.UpdateStatusFn = func(_ context.Context, userID string, status models.UserStatus) error {
		if userID != "user-9" {
			t.Errorf("UpdateStatus userID = %q, want user-9", userID)
		}
		statusUpdated = status
		return nil
	}

	if err := svc.LogoutAllDevices(ctx, "user-9"); err != nil {
		t.Fatalf("LogoutAllDevices: %v", err)
	}

	if statusUpdated != models.UserStatusOffline {
		t.Errorf("status = %v, want offline", statusUpdated)
	}
	assertRevocationFired(t, spy, "user-9")
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
