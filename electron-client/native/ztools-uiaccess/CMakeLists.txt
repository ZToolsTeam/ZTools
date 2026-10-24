cmake_minimum_required(VERSION 3.24)
project(ztools-uiaccess LANGUAGES CXX RC)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(ztools-uiaccess
  main.cpp
  uiaccess_worker.hpp
  uiaccess.rc
)

target_include_directories(ztools-uiaccess PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../shared
)

target_link_libraries(ztools-uiaccess PRIVATE
  ole32
  oleaut32
  user32
  psapi
)

# Standard target for local testing / graceful degradation when unsigned
add_executable(ztools-uiaccess-standard
  main.cpp
  uiaccess_worker.hpp
)

target_include_directories(ztools-uiaccess-standard PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../shared
)

target_link_libraries(ztools-uiaccess-standard PRIVATE
  ole32
  oleaut32
  user32
  psapi
)

if(MSVC)
  target_compile_options(ztools-uiaccess PRIVATE
    /W4
    /utf-8
    /sdl
    /GS
    $<$<CONFIG:Release>:/O2 /GL /guard:cf /Gy>
  )
  set_target_properties(ztools-uiaccess PROPERTIES
    LINK_FLAGS "/MANIFEST:NO"
    LINK_FLAGS_RELEASE "/LTCG /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /guard:cf /DEBUG:NONE"
  )

  target_compile_options(ztools-uiaccess-standard PRIVATE
    /W4
    /utf-8
    /sdl
    /GS
    $<$<CONFIG:Release>:/O2 /GL /guard:cf /Gy>
  )
  set_target_properties(ztools-uiaccess-standard PROPERTIES
    LINK_FLAGS_RELEASE "/LTCG /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /guard:cf /DEBUG:NONE"
  )
endif()

