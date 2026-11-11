#!/usr/bin/env bash
#
# Bootstrap an Android build toolchain in userland — no sudo, no Docker.
#
# Three things this box does not have and needs:
#   * a JDK. The system Java is a headless JRE: /usr/lib/jvm/.../bin contains only
#     java, jpackage, keytool and rmiregistry. No javac, no jar, no jarsigner, so
#     not a single class can be compiled.
#   * the Android SDK (platform + build-tools + platform-tools).
#   * Gradle, which the wrapper downloads itself.
#
# And one trap that will otherwise cost a day: dl.google.com resolves IPv6-first
# here and returns HTTP 404 for EVERY object path over IPv6, while IPv4 returns
# 200 (verified: the same URL is 404 on -6 and 164760899 bytes on -4). /etc/gai.conf
# is commented out and changing it needs root, so the fix is per-process:
#   * curl -4 for direct downloads
#   * -Djava.net.preferIPv4Stack=true for sdkmanager and for Gradle's dependency
#     resolution, which pulls androidx/media3 from dl.google.com
#
# Idempotent: re-running skips whatever is already present.
#
# Usage:  scripts/android-env.sh          # install
#         . scripts/android-env.sh --env  # only export the variables
set -euo pipefail

MAMBA_BIN="${MAMBA_BIN:-$HOME/.local/bin/micromamba}"
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$HOME/.local/share/mamba}"
JDK_ENV=andjdk
export JAVA_HOME="$MAMBA_ROOT_PREFIX/envs/$JDK_ENV"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
# Propagates to every JVM these tools spawn. It prints a banner to stderr, so do
# not parse stderr from anything invoked below.
export JAVA_TOOL_OPTIONS="-Djava.net.preferIPv4Stack=true"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

CLT_VERSION=13114758
PLATFORM="android-36"
BUILD_TOOLS="35.0.0"

if [ "${1:-}" = "--env" ]; then return 0 2>/dev/null || exit 0; fi

say() { printf '\n== %s\n' "$*"; }

say "1/4 JDK 21 (conda-forge, userland)"
# 21 rather than the newest: AGP pins a supported JDK range and 25 is ahead of it.
if [ -x "$JAVA_HOME/bin/javac" ]; then
  echo "   already present: $("$JAVA_HOME/bin/javac" -version 2>&1)"
else
  "$MAMBA_BIN" create -y -q -n "$JDK_ENV" -c conda-forge openjdk=21
  echo "   installed: $("$JAVA_HOME/bin/javac" -version 2>&1)"
fi

say "2/4 Android command-line tools"
if [ -x "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "   already present"
else
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
  tmp=$(mktemp -d)
  # -4 is mandatory here; see the header.
  curl -4 -fL --retry 3 -o "$tmp/clt.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CLT_VERSION}_latest.zip"
  unzip -q "$tmp/clt.zip" -d "$tmp"
  rm -rf "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  rm -rf "$tmp"
  echo "   installed at $ANDROID_SDK_ROOT/cmdline-tools/latest"
fi

say "3/4 SDK packages"
if [ -d "$ANDROID_SDK_ROOT/platforms/$PLATFORM" ] && [ -d "$ANDROID_SDK_ROOT/build-tools/$BUILD_TOOLS" ]; then
  echo "   platform $PLATFORM and build-tools $BUILD_TOOLS already present"
else
  yes 2>/dev/null | sdkmanager --sdk_root="$ANDROID_SDK_ROOT" --licenses >/dev/null || true
  sdkmanager --sdk_root="$ANDROID_SDK_ROOT" \
    "platform-tools" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS"
fi

say "4/4 summary"
cat <<INFO
   JAVA_HOME         $JAVA_HOME
   ANDROID_SDK_ROOT  $ANDROID_SDK_ROOT
   javac             $("$JAVA_HOME/bin/javac" -version 2>&1)
   platforms         $(ls "$ANDROID_SDK_ROOT/platforms" 2>/dev/null | tr '\n' ' ')
   build-tools       $(ls "$ANDROID_SDK_ROOT/build-tools" 2>/dev/null | tr '\n' ' ')

   To use it in a shell:   . scripts/android-env.sh --env
   Gradle needs the same IPv4 flag; apps/mobile/android/gradle.properties sets it.

   This box can BUILD an apk but never RUN one: no KVM, so no emulator, and no
   attached device. Install the artifact on a real phone to test it.
INFO
