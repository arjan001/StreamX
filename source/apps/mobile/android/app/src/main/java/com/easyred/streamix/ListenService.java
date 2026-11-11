package com.easyred.streamix;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * A foreground service that exists so Android will let us hear ourselves.
 *
 * It does no work. Capturing this app's own audio needs a `MediaProjection`, and
 * from Android 10 a projection may only be held by a process running a
 * foreground service — from Android 14, one declaring the `mediaProjection` type
 * specifically, or the system throws `SecurityException` the moment the token is
 * used. So this starts, shows the notice Android requires it to show, and waits
 * to be stopped.
 *
 * The notification is not decoration and must not be hidden. A device that is
 * listening to itself should say so, in the place the operating system puts such
 * things, for exactly as long as it is true.
 */
public class ListenService extends Service {
    private static final String CHANNEL = "listen";
    private static final int NOTE_ID = 0x5713;

    /**
     * Counted down once this service is actually in the foreground.
     *
     * `startForegroundService` returns immediately and the service starts a
     * moment later, but a `MediaProjection` token redeemed before its foreground
     * service exists throws on Android 14 and newer — "Media projections require
     * a foreground service of type FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION" —
     * and does so only on the newest devices, which is the worst possible
     * distribution for a bug. So the plugin waits for this.
     */
    private static volatile java.util.concurrent.CountDownLatch ready =
        new java.util.concurrent.CountDownLatch(1);

    /** Called before starting, so a second sitting does not see the first's latch. */
    static void arm() {
        ready = new java.util.concurrent.CountDownLatch(1);
    }

    static boolean awaitForeground(long ms) {
        try {
            return ready.await(ms, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            final NotificationChannel ch = new NotificationChannel(
                CHANNEL, "Subtitles", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while the app is listening to its own sound to write subtitles.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        final Notification note = new Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Writing down what is being said")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTE_ID, note);
            }
        } catch (Throwable t) {
            /* Refused — the plugin's wait times out and it says so. Never take
               the app down over a notification. */
            stopSelf();
            return START_NOT_STICKY;
        }
        ready.countDown();
        return START_NOT_STICKY;
    }

    /* Deliberately not sticky and deliberately not restarted: permission to
       listen is granted for one sitting, and a service that came back by itself
       would outlive the grant the viewer actually gave. */
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
