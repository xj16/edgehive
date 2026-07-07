# ---------------------------------------------------------------------------
# Firebase Firestore + Auth emulator, self-contained.
#
# The Firestore emulator is a Java process, so we start from a JDK image and add
# Node (for the Firebase CLI). The emulator config comes from the repo's
# firebase.json / firestore.rules, copied in below.
# ---------------------------------------------------------------------------
FROM eclipse-temurin:21-jre-jammy

# Install Node.js 22 (for firebase-tools) without recommends to keep it lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g firebase-tools \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /emulator
# Use the container-specific config that binds emulators to 0.0.0.0 so the
# EdgeHive service can reach them across the compose network.
COPY docker/firebase.json ./firebase.json
COPY firestore.rules .firebaserc ./

# Pre-download the emulator binaries so first boot is fast and offline-capable.
RUN firebase setup:emulators:firestore || true

EXPOSE 8080 9099 4000

# Bind to 0.0.0.0 so the EdgeHive container can reach the emulator over the
# compose network.
CMD ["firebase", "emulators:start", \
     "--only", "firestore,auth", \
     "--project", "edgehive-demo"]
