cmake_minimum_required(VERSION 3.24)
project(ztools-indexer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# 静态链接 MSVC 运行库（/MT），避免目标机器缺少 VC++ Redistributable 时启动失败
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(ztools-indexer
  main.cpp
  file_scanner.hpp
  flat_trie.hpp
  index_cache.hpp
  pinyin.hpp
  pinyin_table.hpp
  query_engine.hpp
)

target_include_directories(ztools-indexer PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../shared
)

if(MSVC)
  target_compile_options(ztools-indexer PRIVATE
    /W4
    /utf-8
    /sdl
    /GS
    $<$<CONFIG:Release>:/O2 /GL /guard:cf /Gy>
  )
  set_target_properties(ztools-indexer PROPERTIES
    LINK_FLAGS_RELEASE "/LTCG /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /guard:cf /DEBUG:NONE"
  )
else()
  find_package(Threads REQUIRED)
  target_link_libraries(ztools-indexer PRIVATE Threads::Threads)
  target_compile_options(ztools-indexer PRIVATE
    -Wall
    -Wextra
    $<$<CONFIG:Release>:-O3>
  )
endif()
