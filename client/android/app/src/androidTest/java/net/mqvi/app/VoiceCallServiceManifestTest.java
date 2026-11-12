package net.mqvi.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
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
}
