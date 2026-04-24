cmake_minimum_required(VERSION 3.15)
project(ZeroEQDSP LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(zeroeq_dsp
    src/wasm_exports.cpp
)

target_include_directories(zeroeq_dsp PRIVATE src)

if(EMSCRIPTEN)
    set_target_properties(zeroeq_dsp PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/dist"
    )

    set(EXPORTED_FUNCTIONS
        # 初期化 / 解放
        "_dsp_init" "_dsp_destroy"
        # メモリ
        "_dsp_alloc_buffer" "_dsp_free_buffer" "_malloc" "_free"
        # ソース
        "_dsp_load_source" "_dsp_clear_source"
        # トランスポート
        "_dsp_set_playing" "_dsp_is_playing"
        "_dsp_set_loop" "_dsp_seek_normalised"
        "_dsp_consume_stopped_at_end"
        "_dsp_get_position" "_dsp_get_duration"
        # バンドパラメータ（ZeroEQ: 11 バンド × 5〜6 種類）
        "_dsp_set_band_on" "_dsp_set_band_type"
        "_dsp_set_band_freq" "_dsp_set_band_gain"
        "_dsp_set_band_q"  "_dsp_set_band_slope"
        # グローバルパラメータ
        "_dsp_set_bypass"
        "_dsp_set_output_gain_db"
        "_dsp_set_analyzer_mode"
        "_dsp_set_metering_mode"
        # メイン処理 / メーター / スペクトラム
        "_dsp_process_block"
        "_dsp_get_meter_data" "_dsp_reset_momentary"
        "_dsp_drain_spectrum" "_dsp_spectrum_bins"
    )
    list(JOIN EXPORTED_FUNCTIONS "," EXPORTED_FUNCTIONS_STR)

    target_link_options(zeroeq_dsp PRIVATE
        "-sSTANDALONE_WASM=1"
        "-sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS_STR}]"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sINITIAL_MEMORY=16777216"
        "-sSTACK_SIZE=131072"
        "-sWASM=1"
        "--no-entry"
        "-O3"
    )
endif()
