cmake_minimum_required(VERSION 3.24)

project(ZToolsNativeComponents LANGUAGES CXX RC)

if(NOT WIN32)
  message(FATAL_ERROR "ZTools native components only support Windows")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "ZTools native components must be built for Win32/ia32")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(ZTOOLS_BUILD_NATIVE_TEST_FIXTURE "Build the NativeHost32 ABI test fixture" OFF)
option(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS "Build the Service manifest test probe" OFF)

add_subdirectory(ZToolsNativeHost32)
add_subdirectory(ZToolsService)
