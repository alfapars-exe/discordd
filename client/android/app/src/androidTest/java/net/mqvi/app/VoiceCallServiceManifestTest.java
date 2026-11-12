package net.mqvi.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.Manifest;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class VoiceCallServiceManifestTest {
    @Test
    public void installedServiceIsPrivateAndDeclaresItsCaptureTypes() throws Exception {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("net.mqvi.app", app.getPackageName());
        ServiceInfo service = app.getPackageManager().getServiceInfo(
            new ComponentName(app, VoiceCallService.class), 0);
        assertFalse(service.exported);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int required = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            assertEquals(required, service.getForegroundServiceType() & required);
        }
    }

    @Test
    public void freshInstallCanRunAndStopPlaybackServiceWithoutMicrophonePermission() {
        Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(PackageManager.PERMISSION_DENIED, app.checkSelfPermission(Manifest.permission.RECORD_AUDIO));
        Intent service = new Intent(app, VoiceCallService.class);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            try {
                activity.onActivity(owner -> ContextCompat.startForegroundService(owner, service));
                awaitForegroundState(app, true);
            } finally {
                app.stopService(service);
            }
            awaitForegroundState(app, false);
        }
    }

    // Android still exposes the calling application's own running services.
    @SuppressWarnings("deprecation")
    private static void awaitForegroundState(Context app, boolean expected) {
        ActivityManager manager = app.getSystemService(ActivityManager.class);
        ComponentName component = new ComponentName(app, VoiceCallService.class);
        long deadline = SystemClock.elapsedRealtime() + 5000;
        do {
            boolean foreground = false;
            for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(Integer.MAX_VALUE)) {
                if (component.equals(service.service) && service.foreground) foreground = true;
            }
            if (foreground == expected) return;
            SystemClock.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        org.junit.Assert.fail("Expected voice service foreground state " + expected);
    }
}
