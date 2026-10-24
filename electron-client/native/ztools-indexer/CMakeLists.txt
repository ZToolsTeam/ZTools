cmake_minimum_required(VERSION 3.24)
project(ztools-indexer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(ztools-indexer
  main.cpp
  file_scanner.hpp
  flat_trie.hpp
  pinyin.hpp
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
endif()
