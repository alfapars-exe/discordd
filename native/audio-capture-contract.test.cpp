// Compile the standalone helper into this test so it uses the shipped packet loop.
#define wmain AudioCaptureMain
#include "audio-capture.cpp"
#undef wmain
#include <cassert>

struct FailingCaptureClient : IAudioCaptureClient {
    bool failRead = true;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT STDMETHODCALLTYPE GetNextPacketSize(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetBuffer(BYTE**, UINT32* frames, DWORD*, UINT64*, UINT64*) override {
        *frames = 0;
        return failRead ? AUDCLNT_E_DEVICE_INVALIDATED : S_OK;
    }
    HRESULT STDMETHODCALLTYPE ReleaseBuffer(UINT32) override { return AUDCLNT_E_OUT_OF_ORDER; }
};

static void CheckCaptureFailures() {
    // The CI runner may start this process with a closed input pipe.
    SetStdHandle(STD_INPUT_HANDLE, nullptr);
    FailingCaptureClient capture;
    std::unique_ptr<void, decltype(&CloseHandle)> event(CreateEvent(nullptr, TRUE, TRUE, nullptr), CloseHandle);
    assert(event);
    assert(CapturePackets(&capture, event.get(), 4) == AUDCLNT_E_DEVICE_INVALIDATED);
    capture.failRead = false;
    assert(CapturePackets(&capture, event.get(), 4) == AUDCLNT_E_OUT_OF_ORDER);
    assert(CapturePackets(&capture, nullptr, 4) == HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE));
}

static void CheckDecoderFormats() {
    WAVEFORMATEXTENSIBLE format{};
    format.Format = {WAVE_FORMAT_EXTENSIBLE, 2, 48000, 384000, 8, 32, 22};
    format.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;
    format.Samples.wValidBitsPerSample = 24;
    assert(!SupportsCaptureFormat(format.Format));
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    format.Samples.wValidBitsPerSample = 32;
    assert(SupportsCaptureFormat(format.Format));
    format.Format.cbSize = 2;
    assert(!SupportsCaptureFormat(format.Format));
    format.Format = {WAVE_FORMAT_PCM, 2, 48000, 192000, 4, 16, 0};
    assert(SupportsCaptureFormat(format.Format));
    format.Format.nBlockAlign = 6;
    assert(!SupportsCaptureFormat(format.Format));
}

int main() {
    CheckDecoderFormats();
    CheckCaptureFailures();
}
