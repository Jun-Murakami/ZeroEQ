// 軽量 radix-2 Cooley-Tukey FFT。Analyzer 用に 2^n サイズの complex FFT を in-place で行う。
//  実部・虚部を交互に [re0, im0, re1, im1, ...] で持つ layout。
//  JUCE の juce::dsp::FFT::performRealOnlyForwardTransform と同じ出力レイアウトに合わせる:
//    実入力は im を全て 0 にして呼び、完了後に bin k の (re, im) を fftScratch_[2k], [2k+1] で読む。
#pragma once

#include <cmath>
#include <cstddef>
#include <vector>

namespace ze_wasm {

class FFT
{
public:
    void setOrder(int order) noexcept
    {
        order_ = order;
        size_  = 1 << order;
        buildBitReverseTable();
        buildTwiddleTable();
    }

    int  getSize()  const noexcept { return size_; }
    int  getOrder() const noexcept { return order_; }

    // data: size = 2 * size_ (interleaved re/im)。in-place で forward FFT。
    void performForward(float* data) noexcept
    {
        const int n = size_;

        // 1) bit-reversal permutation
        for (int i = 0; i < n; ++i)
        {
            const int j = bitRev_[static_cast<size_t>(i)];
            if (j > i)
            {
                std::swap(data[2 * i],     data[2 * j]);
                std::swap(data[2 * i + 1], data[2 * j + 1]);
            }
        }

        // 2) butterflies
        for (int s = 1; s <= order_; ++s)
        {
            const int m  = 1 << s;        // stage size
            const int m2 = m >> 1;
            const int stride = n / m;
            for (int k = 0; k < n; k += m)
            {
                for (int j = 0; j < m2; ++j)
                {
                    const int twIdx = j * stride;
                    const float wr = twiddleCos_[static_cast<size_t>(twIdx)];
                    const float wi = twiddleSin_[static_cast<size_t>(twIdx)];

                    const int idxT = 2 * (k + j);
                    const int idxB = 2 * (k + j + m2);

                    const float tr = data[idxB]     * wr - data[idxB + 1] * wi;
                    const float ti = data[idxB]     * wi + data[idxB + 1] * wr;

                    data[idxB]     = data[idxT]     - tr;
                    data[idxB + 1] = data[idxT + 1] - ti;
                    data[idxT]     = data[idxT]     + tr;
                    data[idxT + 1] = data[idxT + 1] + ti;
                }
            }
        }
    }

private:
    void buildBitReverseTable()
    {
        bitRev_.assign(static_cast<size_t>(size_), 0);
        const int bits = order_;
        for (int i = 0; i < size_; ++i)
        {
            int x = i, r = 0;
            for (int b = 0; b < bits; ++b)
            {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            bitRev_[static_cast<size_t>(i)] = r;
        }
    }

    void buildTwiddleTable()
    {
        // forward FFT: w_k = exp(-j * 2π k / N)
        twiddleCos_.assign(static_cast<size_t>(size_ / 2), 0.0f);
        twiddleSin_.assign(static_cast<size_t>(size_ / 2), 0.0f);
        const double two_pi = 6.283185307179586476925286766559;
        for (int k = 0; k < size_ / 2; ++k)
        {
            const double a = -two_pi * static_cast<double>(k) / static_cast<double>(size_);
            twiddleCos_[static_cast<size_t>(k)] = static_cast<float>(std::cos(a));
            twiddleSin_[static_cast<size_t>(k)] = static_cast<float>(std::sin(a));
        }
    }

    int order_ = 0;
    int size_  = 0;
    std::vector<int>   bitRev_;
    std::vector<float> twiddleCos_;
    std::vector<float> twiddleSin_;
};

} // namespace ze_wasm
