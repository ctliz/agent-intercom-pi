const supportedBossFeature = Object.freeze({
  version: "intercom.broker-feature.v1",
  feature: "boss-run-v1",
  featureVersion: 1,
  semanticsHash: "8943eb60d29afa5264322b5cc7df3de245b01b1cf48a8cbf9cfb6188b02fcfa9",
  controlEnvelopeVersion: 1,
  capabilityDigest: "239bee8bb64cc8c149d49ac00c7396f33f375a89a1d6dea6bd86ff840d551a59",
});

/** Immutable build-time contract only; it is not an installed-provider claim. */
export const PI_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY = Object.freeze({
  contractVersion: "pi.boss-protected-provider.v1",
  adapterId: "pi",
  providerPackage: "@ctliz/agent-intercom-pi",
  supportedBaseProtocolVersions: Object.freeze([4]),
  supportedFeatures: Object.freeze([supportedBossFeature]),
  protocolFeatureContractHash: "dae30efe2c48d2de0fe72a7ebdfd107d3feaefc180d42056ba05df6088a94364",
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
