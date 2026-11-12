package net.mqvi.app;

import android.content.Intent;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin to start/stop the VoiceCallService foreground service.
 * Called from JS when user joins/leaves a voice channel.
 */
@CapacitorPlugin(name = "VoiceCallService")
public class VoiceCallPlugin extends Plugin {

    @PluginMethod()
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceCallService.class);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (IllegalStateException | SecurityException error) {
            call.reject("Could not start the voice call service", error);
        }
    }

    @PluginMethod()
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceCallService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
