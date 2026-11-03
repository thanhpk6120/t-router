import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, onEditCaps, caps, thinkingSuffix, onTestImage, imageStatus, isTestingImage, onTestThinking, thinkingStatus, isTestingThinking, enabled }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  // Any probe failure turns the card red; any probe success with no failures
  // turns it green. This keeps a single at-a-glance verdict per model.
  const probeStatuses = [testStatus, imageStatus, thinkingStatus];
  const verdict = probeStatuses.includes("error")
    ? "error"
    : probeStatuses.includes("ok") ? "ok" : undefined;
  const borderColor = verdict === "ok"
    ? "border-green-500/40"
    : verdict === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = verdict === "ok"
    ? "#22c55e"
    : verdict === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`group w-full sm:w-auto min-w-0 max-w-full rounded-lg border px-3 py-2 ${borderColor} ${enabled === false ? "opacity-50" : ""} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <span
          className="material-symbols-outlined shrink-0 text-base mt-0.5 sm:mt-0"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {verdict === "ok" ? "check_circle" : verdict === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code className="w-fit max-w-full break-all rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted sm:max-w-[360px] sm:truncate">{displayModel}</code>
          <span className="flex min-w-0 items-center text-[9px] gap-1 pl-1">
            {model.name && <span className="break-all sm:truncate text-[9px] italic text-text-muted/70">{model.name}</span>}
            <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={12} />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {onTest && (
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className={`rounded p-1.5 text-text-muted transition-opacity hover:bg-sidebar hover:text-primary`}
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
          {/* Image probe: only for models the capability table marks as
              vision-capable. A non-vision model would answer as if no image
              was attached, which reads as a pass — so the button is hidden. */}
          {onTestImage && caps?.vision && !caps?.imageOutput && (
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onTestImage}
                disabled={isTestingImage}
                className={`rounded p-1.5 transition-opacity hover:bg-sidebar ${imageStatus === "error" ? "text-red-500" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-sm" style={isTestingImage ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTestingImage ? "progress_activity" : "image"}
                </span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTestingImage ? "Testing image..." : imageStatus === "ok" ? "Image OK" : imageStatus === "error" ? "Image failed" : "Test image"}
              </span>
            </div>
          )}
          {/* Thinking probe: only for models that declare reasoning. */}
          {onTestThinking && caps?.reasoning && (
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onTestThinking}
                disabled={isTestingThinking}
                className={`rounded p-1.5 transition-opacity hover:bg-sidebar ${thinkingStatus === "error" ? "text-red-500" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-sm" style={isTestingThinking ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTestingThinking ? "progress_activity" : "neurology"}
                </span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTestingThinking ? "Testing thinking..." : thinkingStatus === "ok" ? "Thinking OK" : thinkingStatus === "error" ? "Thinking failed" : "Test thinking"}
              </span>
            </div>
          )}
          <div className="relative shrink-0 group/btn">
            <button
              onClick={() => onCopy(displayModel, `model-${model.id}`)}
              className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${model.id}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${model.id}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onEditCaps && (
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onEditCaps}
                className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
              >
                <span className="material-symbols-outlined text-sm">tune</span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                Edit caps
              </span>
            </div>
          )}
          {isCustom ? (
            <button
              onClick={onDeleteAlias}
              className="rounded p-1.5 text-text-muted transition-opacity hover:bg-red-500/10 hover:text-red-500"
              title="Remove custom model"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          ) : onDisable ? (
            <button
              onClick={onDisable}
              className={`rounded p-1.5 transition-opacity hover:bg-sidebar ${enabled === false ? "text-text-muted/50 hover:text-primary" : "text-primary hover:text-text-muted"}`}
              title={enabled === false ? "Enable this model" : "Disable this model"}
              aria-pressed={enabled !== false}
            >
              <span className="material-symbols-outlined text-sm">
                {enabled === false ? "toggle_off" : "toggle_on"}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  onTestImage: PropTypes.func,
  imageStatus: PropTypes.string,
  isTestingImage: PropTypes.bool,
  onTestThinking: PropTypes.func,
  thinkingStatus: PropTypes.string,
  isTestingThinking: PropTypes.bool,
  enabled: PropTypes.bool,
  onEditCaps: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
