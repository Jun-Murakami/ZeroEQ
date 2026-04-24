#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "ParameterIDs.h"
#include "Version.h"
#include "KeyEventForwarder.h"

#include <unordered_map>
#include <cmath>

#if defined(JUCE_WINDOWS)
 #include <windows.h>
#endif

#if __has_include(<WebViewFiles.h>)
#include <WebViewFiles.h>
#endif

#ifndef LOCAL_DEV_SERVER_ADDRESS
#define LOCAL_DEV_SERVER_ADDRESS "http://127.0.0.1:5173"
#endif

namespace {

std::vector<std::byte> streamToVector(juce::InputStream& stream)
{
    const auto sizeInBytes = static_cast<size_t>(stream.getTotalLength());
    std::vector<std::byte> result(sizeInBytes);
    stream.setPosition(0);
    [[maybe_unused]] const auto bytesRead = stream.read(result.data(), result.size());
    jassert(static_cast<size_t>(bytesRead) == sizeInBytes);
    return result;
}

#if !ZEROEQ_DEV_MODE && __has_include(<WebViewFiles.h>)
static const char* getMimeForExtension(const juce::String& extension)
{
    static const std::unordered_map<juce::String, const char*> mimeMap = {
        {{"htm"},   "text/html"},
        {{"html"},  "text/html"},
        {{"txt"},   "text/plain"},
        {{"jpg"},   "image/jpeg"},
        {{"jpeg"},  "image/jpeg"},
        {{"svg"},   "image/svg+xml"},
        {{"ico"},   "image/vnd.microsoft.icon"},
        {{"json"},  "application/json"},
        {{"png"},   "image/png"},
        {{"css"},   "text/css"},
        {{"map"},   "application/json"},
        {{"js"},    "text/javascript"},
        {{"woff2"}, "font/woff2"}};

    if (const auto it = mimeMap.find(extension.toLowerCase()); it != mimeMap.end())
        return it->second;

    jassertfalse;
    return "";
}

#ifndef ZIPPED_FILES_PREFIX
#error "You must provide the prefix of zipped web UI files' paths via ZIPPED_FILES_PREFIX compile definition"
#endif

std::vector<std::byte> getWebViewFileAsBytes(const juce::String& filepath)
{
    juce::MemoryInputStream zipStream{ webview_files::webview_files_zip,
                                       webview_files::webview_files_zipSize,
                                       false };
    juce::ZipFile zipFile{ zipStream };

    const auto fullPath = ZIPPED_FILES_PREFIX + filepath;
    if (auto* zipEntry = zipFile.getEntry(fullPath))
    {
        const std::unique_ptr<juce::InputStream> entryStream{ zipFile.createStreamForEntry(*zipEntry) };
        if (entryStream == nullptr) { jassertfalse; return {}; }
        return streamToVector(*entryStream);
    }
    return {};
}
#else
[[maybe_unused]] static std::vector<std::byte> getWebViewFileAsBytes(const juce::String& filepath)
{
    juce::ignoreUnused(filepath);
    return {};
}
#endif

#if defined(JUCE_WINDOWS)
static void queryWindowDpi(HWND hwnd, int& outDpi, double& outScale)
{
    outDpi = 0;
    outScale = 1.0;
    if (hwnd == nullptr) return;

    HMODULE user32 = ::GetModuleHandleW(L"user32.dll");
    if (user32 != nullptr)
    {
        using GetDpiForWindowFn = UINT (WINAPI*)(HWND);
        auto pGetDpiForWindow = reinterpret_cast<GetDpiForWindowFn>(::GetProcAddress(user32, "GetDpiForWindow"));
        if (pGetDpiForWindow != nullptr)
        {
            const UINT dpi = pGetDpiForWindow(hwnd);
            if (dpi != 0)
            {
                outDpi = static_cast<int>(dpi);
                outScale = static_cast<double>(dpi) / 96.0;
                return;
            }
        }
    }

    HMODULE shcore = ::LoadLibraryW(L"Shcore.dll");
    if (shcore != nullptr)
    {
        using GetDpiForMonitorFn = HRESULT (WINAPI*)(HMONITOR, int, UINT*, UINT*);
        auto pGetDpiForMonitor = reinterpret_cast<GetDpiForMonitorFn>(::GetProcAddress(shcore, "GetDpiForMonitor"));
        if (pGetDpiForMonitor != nullptr)
        {
            HMONITOR mon = ::MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            UINT dpiX = 0, dpiY = 0;
            if (SUCCEEDED(pGetDpiForMonitor(mon, 0 /*MDT_EFFECTIVE_DPI*/, &dpiX, &dpiY)))
            {
                outDpi = static_cast<int>(dpiX);
                outScale = static_cast<double>(dpiX) / 96.0;
            }
        }
        ::FreeLibrary(shcore);
    }
}
#endif

} // namespace

// WebView2/Chromium の起動前にコマンドライン引数（--force-device-scale-factor=1）を
// 注入。ProTools Windows (AAX) 等 DPI 非対応ホスト対策。
static juce::WebBrowserComponent::Options makeWebViewOptionsWithPreLaunchArgs(const juce::AudioProcessor& /*processor*/)
{
   #if defined(JUCE_WINDOWS)
    if (juce::PluginHostType().isProTools()
        && juce::PluginHostType::getPluginLoadedAs() == juce::AudioProcessor::WrapperType::wrapperType_AAX)
    {
        const char* kEnvName = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        const char* kArg     = "--force-device-scale-factor=1";

        char*  existing = nullptr;
        size_t len = 0;
        if (_dupenv_s(&existing, &len, kEnvName) == 0 && existing != nullptr)
        {
            std::string combined(existing);
            free(existing);
            if (combined.find("--force-device-scale-factor") == std::string::npos)
            {
                if (! combined.empty()) combined += ' ';
                combined += kArg;
                _putenv_s(kEnvName, combined.c_str());
            }
        }
        else
        {
            _putenv_s(kEnvName, kArg);
        }
    }
   #endif
    return juce::WebBrowserComponent::Options{};
}

//==============================================================================
//  バンド relay / attachment を populate するヘルパ
//==============================================================================
namespace {

template <typename RelayT>
static std::vector<std::unique_ptr<RelayT>> makeBandRelays(juce::String (*idFn)(int))
{
    std::vector<std::unique_ptr<RelayT>> out;
    out.reserve(ze::id::kNumBands);
    for (int i = 0; i < ze::id::kNumBands; ++i)
        out.push_back(std::make_unique<RelayT>(idFn(i)));
    return out;
}

template <typename AttachT, typename RelayT>
static std::vector<std::unique_ptr<AttachT>>
makeBandAttachments(juce::AudioProcessorValueTreeState& apvts,
                    const std::vector<std::unique_ptr<RelayT>>& relays,
                    juce::String (*idFn)(int))
{
    std::vector<std::unique_ptr<AttachT>> out;
    out.reserve(ze::id::kNumBands);
    for (int i = 0; i < ze::id::kNumBands; ++i)
    {
        auto* param = apvts.getParameter(idFn(i));
        jassert(param != nullptr);
        out.push_back(std::make_unique<AttachT>(*param, *relays[static_cast<size_t>(i)], nullptr));
    }
    return out;
}

} // namespace

//==============================================================================

ZeroEQAudioProcessorEditor::ZeroEQAudioProcessorEditor(ZeroEQAudioProcessor& p)
    : AudioProcessorEditor(&p),
      audioProcessor(p),
      webBypassRelay        { ze::id::BYPASS.getParamID() },
      webOutputGainRelay    { ze::id::OUTPUT_GAIN.getParamID() },
      webAnalyzerModeRelay  { ze::id::ANALYZER_MODE.getParamID() },
      bypassAttachment      { *p.getState().getParameter(ze::id::BYPASS.getParamID()),        webBypassRelay,       nullptr },
      outputGainAttachment  { *p.getState().getParameter(ze::id::OUTPUT_GAIN.getParamID()),   webOutputGainRelay,   nullptr },
      analyzerModeAttachment{ *p.getState().getParameter(ze::id::ANALYZER_MODE.getParamID()), webAnalyzerModeRelay, nullptr },
      bandOnRelays          { makeBandRelays<juce::WebToggleButtonRelay>(&ze::id::bandOnID)    },
      bandTypeRelays        { makeBandRelays<juce::WebComboBoxRelay>    (&ze::id::bandTypeID)  },
      bandFreqRelays        { makeBandRelays<juce::WebSliderRelay>      (&ze::id::bandFreqID)  },
      bandGainRelays        { makeBandRelays<juce::WebSliderRelay>      (&ze::id::bandGainID)  },
      bandQRelays           { makeBandRelays<juce::WebSliderRelay>      (&ze::id::bandQID)     },
      bandSlopeRelays       { makeBandRelays<juce::WebComboBoxRelay>    (&ze::id::bandSlopeID) },
      bandOnAttachments     { makeBandAttachments<juce::WebToggleButtonParameterAttachment>(p.getState(), bandOnRelays,    &ze::id::bandOnID)    },
      bandTypeAttachments   { makeBandAttachments<juce::WebComboBoxParameterAttachment>    (p.getState(), bandTypeRelays,  &ze::id::bandTypeID)  },
      bandFreqAttachments   { makeBandAttachments<juce::WebSliderParameterAttachment>      (p.getState(), bandFreqRelays,  &ze::id::bandFreqID)  },
      bandGainAttachments   { makeBandAttachments<juce::WebSliderParameterAttachment>      (p.getState(), bandGainRelays,  &ze::id::bandGainID)  },
      bandQAttachments      { makeBandAttachments<juce::WebSliderParameterAttachment>      (p.getState(), bandQRelays,     &ze::id::bandQID)     },
      bandSlopeAttachments  { makeBandAttachments<juce::WebComboBoxParameterAttachment>    (p.getState(), bandSlopeRelays, &ze::id::bandSlopeID) },
      webView{
          [this]() {
              auto opts = makeWebViewOptionsWithPreLaunchArgs(audioProcessor)
                  .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
                  .withWinWebView2Options(
                      juce::WebBrowserComponent::Options::WinWebView2{}
                          .withBackgroundColour(juce::Colour(0xFF202428))
                          .withUserDataFolder(juce::File::getSpecialLocation(
                              juce::File::SpecialLocationType::tempDirectory)))
                  .withWebViewLifetimeListener(&webViewLifetimeGuard)
                  .withNativeIntegrationEnabled()
                  .withInitialisationData("vendor", "ZeroEQ")
                  .withInitialisationData("pluginName", "ZeroEQ")
                  .withInitialisationData("pluginVersion", ZEROEQ_VERSION_STRING)
                  .withOptionsFrom(controlParameterIndexReceiver)
                  .withOptionsFrom(webBypassRelay)
                  .withOptionsFrom(webOutputGainRelay)
                  .withOptionsFrom(webAnalyzerModeRelay);

              for (auto& r : bandOnRelays)    opts = opts.withOptionsFrom(*r);
              for (auto& r : bandTypeRelays)  opts = opts.withOptionsFrom(*r);
              for (auto& r : bandFreqRelays)  opts = opts.withOptionsFrom(*r);
              for (auto& r : bandGainRelays)  opts = opts.withOptionsFrom(*r);
              for (auto& r : bandQRelays)     opts = opts.withOptionsFrom(*r);
              for (auto& r : bandSlopeRelays) opts = opts.withOptionsFrom(*r);

              opts = opts
                  .withNativeFunction(
                      juce::Identifier{"system_action"},
                      [this](const juce::Array<juce::var>& args,
                             juce::WebBrowserComponent::NativeFunctionCompletion completion)
                      { handleSystemAction(args, std::move(completion)); })
                  .withNativeFunction(
                      juce::Identifier{"window_action"},
                      [this](const juce::Array<juce::var>& args,
                             juce::WebBrowserComponent::NativeFunctionCompletion completion)
                      {
                          auto clampW = [](int w) { return juce::jlimit(kMinWidth,  kMaxWidth,  w); };
                          auto clampH = [](int h) { return juce::jlimit(kMinHeight, kMaxHeight, h); };
                          if (args.size() > 0)
                          {
                              const auto action = args[0].toString();
                              if (action == "resizeTo" && args.size() >= 3)
                              {
                                  setSize(clampW(juce::roundToInt((double) args[1])),
                                          clampH(juce::roundToInt((double) args[2])));
                                  completion(juce::var{ true });
                                  return;
                              }
                              if (action == "resizeBy" && args.size() >= 3)
                              {
                                  const int dw = juce::roundToInt((double) args[1]);
                                  const int dh = juce::roundToInt((double) args[2]);
                                  setSize(clampW(getWidth() + dw), clampH(getHeight() + dh));
                                  completion(juce::var{ true });
                                  return;
                              }
                          }
                          completion(juce::var{ false });
                      })
                  .withNativeFunction(
                      juce::Identifier{"open_url"},
                      [](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion completion)
                      {
                          if (args.size() > 0)
                              juce::URL(args[0].toString()).launchInDefaultBrowser();
                          completion(juce::var{ true });
                      })
                  .withResourceProvider([this](const juce::String& url) { return getResource(url); });
              return opts;
          }()
      }
{
   #if ZEROEQ_DEV_MODE
    useLocalDevServer = true;
   #else
    useLocalDevServer = false;
   #endif

    addAndMakeVisible(webView);
    setSize(875, 450);

    setResizable(true, true);
    setResizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);
    resizerConstraints.setSizeLimits(kMinWidth, kMinHeight, kMaxWidth, kMaxHeight);

    resizer.reset(new juce::ResizableCornerComponent(this, &resizerConstraints));
    addAndMakeVisible(resizer.get());
    resizer->setAlwaysOnTop(true);

    if (auto* hostConstrainer = getConstrainer())
        hostConstrainer->setMinimumOnscreenAmounts(50, 50, 50, 50);

    if (useLocalDevServer)
        webView.goToURL(LOCAL_DEV_SERVER_ADDRESS);
    else
        webView.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

    // 一部ホスト（Pro Tools AAX など）はコンストラクタ中の setSize を無視するため、
    // 次のメッセージループで最小値を割っていたら初期サイズを強制する。
    juce::Component::SafePointer<ZeroEQAudioProcessorEditor> safeSelf { this };
    juce::MessageManager::callAsync([safeSelf]()
    {
        if (safeSelf == nullptr) return;
        if (safeSelf->getWidth() < kMinWidth || safeSelf->getHeight() < kMinHeight)
            safeSelf->setSize(875, 450);
    });

    // 60Hz。メーター / スペクトラム / DPI ポーリングの駆動源。
    // ディスプレイ vsync と合い、スペクトラム描画が 30Hz より滑らかに見える。
    startTimerHz(60);
}

ZeroEQAudioProcessorEditor::~ZeroEQAudioProcessorEditor()
{
    isShuttingDown.store(true, std::memory_order_release);
    stopTimer();
}

void ZeroEQAudioProcessorEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour(0xFF202428));
}

void ZeroEQAudioProcessorEditor::resized()
{
    webView.setBounds(getLocalBounds());
    if (resizer)
    {
        const int gripperSize = 24;
        resizer->setBounds(getWidth() - gripperSize, getHeight() - gripperSize, gripperSize, gripperSize);
        resizer->toFront(true);
    }
}

std::optional<ZeroEQAudioProcessorEditor::Resource>
ZeroEQAudioProcessorEditor::getResource(const juce::String& url) const
{
   #if ZEROEQ_DEV_MODE
    juce::ignoreUnused(url);
    return std::nullopt;
   #else
    #if __has_include(<WebViewFiles.h>)
    const auto cleaned = url.startsWith("/") ? url.substring(1) : url;
    const auto resourcePath = cleaned.isEmpty() ? juce::String("index.html") : cleaned;
    const auto bytes = getWebViewFileAsBytes(resourcePath);
    if (bytes.empty())
        return std::nullopt;

    const auto extension = resourcePath.fromLastOccurrenceOf(".", false, false);
    return Resource{ std::move(bytes), juce::String(getMimeForExtension(extension)) };
    #else
    juce::ignoreUnused(url);
    return std::nullopt;
    #endif
   #endif
}

void ZeroEQAudioProcessorEditor::handleSystemAction(const juce::Array<juce::var>& args,
                                                     juce::WebBrowserComponent::NativeFunctionCompletion completion)
{
    if (args.size() > 0)
    {
        const auto action = args[0].toString();
        if (action == "ready")
        {
            juce::DynamicObject::Ptr init{ new juce::DynamicObject{} };
            init->setProperty("pluginName", "ZeroEQ");
            init->setProperty("version", ZEROEQ_VERSION_STRING);
            init->setProperty("numBands", ze::id::kNumBands);
            completion(juce::var{ init.get() });
            return;
        }
        if (action == "forward_key_event" && args.size() >= 2)
        {
            const bool forwarded = ze::KeyEventForwarder::forwardKeyEventToHost(args[1], this);
            completion(juce::var{ forwarded });
            return;
        }
    }
    completion(juce::var{});
}

#if defined(JUCE_WINDOWS)
void ZeroEQAudioProcessorEditor::pollAndMaybeNotifyDpiChange()
{
    auto* peer = getPeer();
    if (peer == nullptr) return;

    HWND hwnd = (HWND) peer->getNativeHandle();
    int dpi = 0;
    double scale = 1.0;
    queryWindowDpi(hwnd, dpi, scale);
    if (dpi <= 0) return;

    const bool scaleChanged = std::abs(lastHwndScaleFactor - scale) >= 0.01;
    const bool dpiChanged   = lastHwndDpi != dpi;
    if (! (scaleChanged || dpiChanged)) return;

    lastHwndScaleFactor = scale;
    lastHwndDpi = dpi;

    juce::DynamicObject::Ptr payload{ new juce::DynamicObject{} };
    payload->setProperty("scale", scale);
    payload->setProperty("dpi", dpi);
    webView.emitEventIfBrowserIsVisible("dpiScaleChanged", payload.get());

    const int w = getWidth();
    const int h = getHeight();
    setSize(w + 1, h + 1);
    setSize(w, h);
}
#endif

void ZeroEQAudioProcessorEditor::timerCallback()
{
    if (isShuttingDown.load(std::memory_order_acquire)) return;
    if (! webViewLifetimeGuard.isConstructed()) return;

   #if defined(JUCE_WINDOWS)
    pollAndMaybeNotifyDpiChange();
   #endif

    // ---- メーター減衰係数（60Hz タイマで約 20 dB/sec のリリース）----
    //  30Hz の 0.93 を per-second 保持率換算すると 0.93^30 ≈ 0.113。
    //  60Hz 同等にするには x^60 = 0.113 → x ≈ 0.965。
    constexpr float kPeakDecay = 0.965f;
    constexpr float kRmsDecay  = 0.965f;

    auto readAndDecayMax = [](std::atomic<float>& slot, float decay) noexcept
    {
        float cur = slot.load(std::memory_order_relaxed);
        float next = cur * decay;
        while (! slot.compare_exchange_weak(cur, next,
                                             std::memory_order_acq_rel,
                                             std::memory_order_relaxed))
            next = cur * decay;
        return cur;
    };

    const float inPeakL  = readAndDecayMax(audioProcessor.inPeakAccumL,  kPeakDecay);
    const float inPeakR  = readAndDecayMax(audioProcessor.inPeakAccumR,  kPeakDecay);
    const float outPeakL = readAndDecayMax(audioProcessor.outPeakAccumL, kPeakDecay);
    const float outPeakR = readAndDecayMax(audioProcessor.outPeakAccumR, kPeakDecay);

    const float inRmsL  = readAndDecayMax(audioProcessor.inRmsAccumL,  kRmsDecay);
    const float inRmsR  = readAndDecayMax(audioProcessor.inRmsAccumR,  kRmsDecay);
    const float outRmsL = readAndDecayMax(audioProcessor.outRmsAccumL, kRmsDecay);
    const float outRmsR = readAndDecayMax(audioProcessor.outRmsAccumR, kRmsDecay);

    juce::DynamicObject::Ptr meter { new juce::DynamicObject{} };
    juce::DynamicObject::Ptr input { new juce::DynamicObject{} };
    juce::DynamicObject::Ptr output{ new juce::DynamicObject{} };

    input ->setProperty("peakLeft",  juce::Decibels::gainToDecibels(inPeakL,  -60.0f));
    input ->setProperty("peakRight", juce::Decibels::gainToDecibels(inPeakR,  -60.0f));
    input ->setProperty("rmsLeft",   juce::Decibels::gainToDecibels(inRmsL,   -60.0f));
    input ->setProperty("rmsRight",  juce::Decibels::gainToDecibels(inRmsR,   -60.0f));
    input ->setProperty("momentary", static_cast<double>(audioProcessor.inputMomentary.getMomentaryLKFS()));

    output->setProperty("peakLeft",  juce::Decibels::gainToDecibels(outPeakL, -60.0f));
    output->setProperty("peakRight", juce::Decibels::gainToDecibels(outPeakR, -60.0f));
    output->setProperty("rmsLeft",   juce::Decibels::gainToDecibels(outRmsL,  -60.0f));
    output->setProperty("rmsRight",  juce::Decibels::gainToDecibels(outRmsR,  -60.0f));
    output->setProperty("momentary", static_cast<double>(audioProcessor.outputMomentary.getMomentaryLKFS()));

    meter->setProperty("input",  input.get());
    meter->setProperty("output", output.get());

    webView.emitEventIfBrowserIsVisible("meterUpdate", meter.get());

    // ---- Spectrum（Pre / Post）----
    //  Analyzer::drainAndCompute が新フレームを生成した時だけ emit する。
    //  UI 側は受信した配列を log-freq ビン（kNumDisplayBins 個）として描画すれば良い。
    const bool havePre  = audioProcessor.preAnalyzer .drainAndCompute(preSpectrumScratch .data());
    const bool havePost = audioProcessor.postAnalyzer.drainAndCompute(postSpectrumScratch.data());

    if (havePre || havePost)
    {
        juce::DynamicObject::Ptr spec{ new juce::DynamicObject{} };
        spec->setProperty("numBins", ze::dsp::Analyzer::kNumDisplayBins);

        auto toArray = [](const std::array<float, ze::dsp::Analyzer::kNumDisplayBins>& src)
        {
            juce::Array<juce::var> out;
            out.ensureStorageAllocated(static_cast<int>(src.size()));
            for (const float v : src)
                out.add(juce::var{ static_cast<double>(v) });
            return out;
        };

        if (havePre)  spec->setProperty("pre",  toArray(preSpectrumScratch));
        if (havePost) spec->setProperty("post", toArray(postSpectrumScratch));

        webView.emitEventIfBrowserIsVisible("spectrumUpdate", spec.get());
    }
}
