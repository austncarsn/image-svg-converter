import {
  BACKGROUND_REMOVAL_PROFILES,
  EXPORT_STRATEGIES,
  IMAGE_TRACER_PRESETS,
  PRESET_CONFIGS,
  TRACE_FIDELITY_MODES,
  VTRACER_PROFILE_OPTIONS,
  resolvePreset,
  resolvePipelinePreset,
} from "../src/presets.js";

const visiblePresets = ["logo", "badge", "photo", "drawing", "lineart", "complex", "sticker", "pixelart"];
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

for (const presetId of visiblePresets) {
  const controls = IMAGE_TRACER_PRESETS[presetId];
  const config = resolvePreset(presetId);
  const metadata = PRESET_CONFIGS[presetId];
  const pipeline = resolvePipelinePreset({
    type: presetId,
    subtype: presetId === "badge" ? "badge" : null,
  });

  assert(controls, `${presetId}: missing IMAGE_TRACER_PRESETS controls`);
  assert(metadata, `${presetId}: missing PRESET_CONFIGS metadata`);
  assert(
    EXPORT_STRATEGIES[presetId] === metadata.exportStrategy,
    `${presetId}: export strategy mismatch`
  );
  assert(config.defaultControls, `${presetId}: missing defaultControls`);
  assert(config.controlLimits?.colors, `${presetId}: missing color control limits`);
  assert(
    controls.colors >= config.controlLimits.colors.min,
    `${presetId}: controls colors below min`
  );
  assert(
    controls.colors <= config.controlLimits.colors.max,
    `${presetId}: controls colors above max`
  );
  assert(
    config.defaultControls.colors >= config.controlLimits.colors.min,
    `${presetId}: defaults below min`
  );
  assert(
    config.defaultControls.colors <= config.controlLimits.colors.max,
    `${presetId}: defaults above max`
  );
  assert(
    pipeline.exportStrategy === config.exportStrategy,
    `${presetId}: pipeline strategy mismatch`
  );
}

assert(
  IMAGE_TRACER_PRESETS.lineart.colors === 2,
  "lineart: visible preset must be true two-color monochrome"
);
assert(
  resolvePreset("lineart").controlLimits.colors.max === 2,
  "lineart: color limit must stay locked to 2"
);
assert(BACKGROUND_REMOVAL_PROFILES.includes("logo"), "logo: should remove simple backgrounds");
assert(
  BACKGROUND_REMOVAL_PROFILES.includes("drawing"),
  "drawing: should remove simple backgrounds"
);
assert(
  BACKGROUND_REMOVAL_PROFILES.includes("lineart"),
  "lineart: should remove simple backgrounds"
);
assert(!BACKGROUND_REMOVAL_PROFILES.includes("photo"), "photo: should preserve source pixels");
assert(
  !BACKGROUND_REMOVAL_PROFILES.includes("badge"),
  "badge: should not run generic background removal"
);
assert(
  !BACKGROUND_REMOVAL_PROFILES.includes("sticker"),
  "sticker: should not run generic background removal"
);

assert(
  PRESET_CONFIGS.logo.preprocessing.paletteHint === "cyber-neon",
  "logo: preprocessing paletteHint should enable cyber-neon palette anchoring"
);

assert(
  VTRACER_PROFILE_OPTIONS.logo.spliceThreshold <= 20,
  "logo: spliceThreshold should favor smoother, continuous paths"
);
assert(
  VTRACER_PROFILE_OPTIONS.logo.lengthThreshold <= 2.5,
  "logo: lengthThreshold should preserve typography edge detail"
);
assert(
  VTRACER_PROFILE_OPTIONS.logo.cornerThreshold <= 40,
  "logo: cornerThreshold should avoid jagged edge emphasis"
);

assert(
  TRACE_FIDELITY_MODES.balanced.layerDifference <= 10,
  "balanced fidelity: layerDifference should avoid tiny color fragment islands"
);
assert(
  TRACE_FIDELITY_MODES.high.pathPrecision >= 10,
  "high fidelity: pathPrecision should preserve smoother curves"
);

if (failures.length) {
  console.error("Preset contract failures:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Preset contracts passed for ${visiblePresets.length} visible presets.`);
