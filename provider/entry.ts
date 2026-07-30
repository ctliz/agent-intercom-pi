const supportedBossFeature = Object.freeze({
  version: "intercom.broker-feature.v1",
  feature: "boss-run-v1",
  featureVersion: 1,
  semanticsHash: "91dc85ea8c896b9394ebc30db4689803004dbb1c5455eca763a09d0caef167f1",
  controlEnvelopeVersion: 1,
  capabilityDigest: "6090d92d87223209c653111e2d22a6921e818f71c76b61679f1480ebe021a119",
});

/** Immutable build-time contract only; it is not an installed-provider claim. */
export const PI_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY = Object.freeze({
  contractVersion: "pi.boss-protected-provider.v1",
  adapterId: "pi",
  providerPackage: "@dataforxyz/agent-intercom-pi",
  supportedBaseProtocolVersions: Object.freeze([3]),
  supportedFeatures: Object.freeze([supportedBossFeature]),
  protocolFeatureContractHash: "3532c82524f651a5ea8c18a5d8d9689955237d6f68227fc32b1c38e7ea8825d0",
  authoritative: false,
  providerStartAvailable: false,
  bossAdvertisementEnabled: false,
} as const);

const BOSS_PROTECTED_PROVIDER_START_UNAVAILABLE = "BOSS_PROTECTED_PROVIDER_START_UNAVAILABLE" as const;

class PiBossProtectedProviderStartUnavailableError extends Error {
  readonly code = BOSS_PROTECTED_PROVIDER_START_UNAVAILABLE;

  constructor() {
    super(`${BOSS_PROTECTED_PROVIDER_START_UNAVAILABLE}: protected provider execution is not installed`);
    this.name = "PiBossProtectedProviderStartUnavailableError";
  }
}

/** A later protected service may replace this dormant entry after release gates. */
export function startPiBossProtectedProvider(_request: unknown): never {
  throw new PiBossProtectedProviderStartUnavailableError();
}
