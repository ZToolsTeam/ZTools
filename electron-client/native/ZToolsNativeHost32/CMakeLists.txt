add_executable(ZToolsNativeHost32
  src/dll_host.cpp
  src/input_inject.cpp
  src/keyboard_hook.cpp
  src/dll_resolver.cpp
  src/manifest.cpp
  src/main.cpp
  src/mouse_hook.cpp
  src/protocol.cpp
)

target_include_directories(ZToolsNativeHost32 PRIVATE include)
target_compile_definitions(ZToolsNativeHost32 PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(ZToolsNativeHost32 PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
target_link_options(ZToolsNativeHost32 PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
target_link_libraries(ZToolsNativeHost32 PRIVATE bcrypt ole32 shlwapi user32 xmllite)

set_target_properties(ZToolsNativeHost32 PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_NATIVE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_NATIVE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${ZTOOLS_NATIVE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${ZTOOLS_NATIVE_OUTPUT_DIR}"
)

if(ZTOOLS_BUILD_NATIVE_TEST_FIXTURE)
  if(NOT DEFINED ZTOOLS_NATIVE_TEST_OUTPUT_DIR)
    message(FATAL_ERROR "ZTOOLS_NATIVE_TEST_OUTPUT_DIR is required for the test fixture")
  endif()

  add_library(ZToolsNativeTestPlugin SHARED tests/native_test_plugin.cpp)
  add_library(ZToolsNativeAbiRejectionFixture SHARED tests/native_abi_rejection_plugin.cpp)
  add_executable(ZToolsDllCancelTest tests/dll_cancel_test.cpp)
  target_compile_options(ZToolsDllCancelTest PRIVATE /W4 /WX /utf-8)
  target_link_libraries(ZToolsDllCancelTest PRIVATE ole32)
  set_target_properties(ZToolsDllCancelTest PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
  )
  target_compile_definitions(ZToolsNativeTestPlugin PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_options(ZToolsNativeTestPlugin PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
  target_link_options(ZToolsNativeTestPlugin PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
  target_link_libraries(ZToolsNativeTestPlugin PRIVATE ole32)
  set_target_properties(ZToolsNativeTestPlugin PROPERTIES
    PREFIX ""
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
  )
  target_compile_definitions(ZToolsNativeAbiRejectionFixture PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_options(ZToolsNativeAbiRejectionFixture PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
  target_link_options(ZToolsNativeAbiRejectionFixture PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
  set_target_properties(ZToolsNativeAbiRejectionFixture PROPERTIES
    PREFIX ""
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${ZTOOLS_NATIVE_TEST_OUTPUT_DIR}"
  )
endif()
