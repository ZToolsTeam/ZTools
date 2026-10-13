set(ZTOOLS_PACKAGE_JSON_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../../package.json")
file(READ "${ZTOOLS_PACKAGE_JSON_PATH}" ZTOOLS_PACKAGE_JSON)
string(JSON ZTOOLS_PRODUCT_VERSION ERROR_VARIABLE ZTOOLS_PACKAGE_VERSION_ERROR
  GET "${ZTOOLS_PACKAGE_JSON}" version)
if(NOT ZTOOLS_PACKAGE_VERSION_ERROR STREQUAL "NOTFOUND")
  message(FATAL_ERROR "Unable to read version from ${ZTOOLS_PACKAGE_JSON_PATH}: ${ZTOOLS_PACKAGE_VERSION_ERROR}")
endif()
if(NOT ZTOOLS_PRODUCT_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$")
  message(FATAL_ERROR "ZToolsService requires a four-part numeric package version: ${ZTOOLS_PRODUCT_VERSION}")
endif()
string(REPLACE "." ";" ZTOOLS_PRODUCT_VERSION_COMPONENTS "${ZTOOLS_PRODUCT_VERSION}")
foreach(ZTOOLS_PRODUCT_VERSION_COMPONENT IN LISTS ZTOOLS_PRODUCT_VERSION_COMPONENTS)
  string(LENGTH "${ZTOOLS_PRODUCT_VERSION_COMPONENT}" ZTOOLS_PRODUCT_VERSION_COMPONENT_LENGTH)
  if(NOT ZTOOLS_PRODUCT_VERSION_COMPONENT MATCHES "^(0|[1-9][0-9]*)$" OR
     ZTOOLS_PRODUCT_VERSION_COMPONENT_LENGTH GREATER 5 OR
     ZTOOLS_PRODUCT_VERSION_COMPONENT GREATER 65535)
    message(FATAL_ERROR "ZToolsService package version component is outside 0..65535: ${ZTOOLS_PRODUCT_VERSION_COMPONENT}")
  endif()
endforeach()
string(REPLACE "." "," ZTOOLS_PRODUCT_VERSION_RC "${ZTOOLS_PRODUCT_VERSION}")
set(ZTOOLS_SERVICE_VERSION_RESOURCE "${CMAKE_CURRENT_BINARY_DIR}/ZToolsServiceVersion.rc")
configure_file(ztools_service_version.rc.in "${ZTOOLS_SERVICE_VERSION_RESOURCE}" @ONLY)

add_executable(ZToolsService
  "${ZTOOLS_SERVICE_VERSION_RESOURCE}"
  src/command_dispatcher.cpp
  src/command_policy.cpp
  src/explorer_restarter.cpp
  src/main.cpp
  src/named_pipe_server.cpp
  src/pipe_protocol.cpp
  src/pipe_security.cpp
  src/privileged_dll_loader.cpp
  src/privileged_dll_task_manager.cpp
  src/privileged_dll_resolver.cpp
  src/privileged_manifest.cpp
  src/service_command_protocol.cpp
  src/service_auth.cpp
  src/service_runtime.cpp
  src/service_secret.cpp
)

target_include_directories(ZToolsService PRIVATE include)
target_compile_definitions(ZToolsService PRIVATE ZTOOLS_PRODUCT_VERSION=L"${ZTOOLS_PRODUCT_VERSION}")
target_compile_definitions(ZToolsService PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(ZToolsService PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
target_link_options(ZToolsService PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
target_link_libraries(ZToolsService PRIVATE advapi32 bcrypt shell32 shlwapi userenv wtsapi32 xmllite)

if(NOT DEFINED ZTOOLS_SERVICE_OUTPUT_DIR)
  set(ZTOOLS_SERVICE_OUTPUT_DIR "${CMAKE_BINARY_DIR}/service-win32-ia32")
endif()

set_target_properties(ZToolsService PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_SERVICE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_SERVICE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${ZTOOLS_SERVICE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${ZTOOLS_SERVICE_OUTPUT_DIR}"
)

if(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS)
  target_compile_definitions(ZToolsService PRIVATE ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS=1)
  add_library(ZToolsServiceSessionFixture SHARED tests/session_fixture.cpp tests/session_fixture.def)
  target_compile_options(ZToolsServiceSessionFixture PRIVATE /W4 /WX /utf-8)
  target_link_libraries(ZToolsServiceSessionFixture PRIVATE ole32)
  add_library(ZToolsServicePrivateDependency SHARED
    tests/private_dependency.cpp
  )
  add_library(ZToolsServicePrivateConsumer SHARED
    tests/private_consumer.cpp
  )
  target_compile_definitions(ZToolsServicePrivateDependency PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_definitions(ZToolsServicePrivateConsumer PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_options(ZToolsServicePrivateDependency PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
  target_compile_options(ZToolsServicePrivateConsumer PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
  target_link_options(ZToolsServicePrivateDependency PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
  target_link_options(ZToolsServicePrivateConsumer PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
  target_link_libraries(ZToolsServicePrivateConsumer PRIVATE ZToolsServicePrivateDependency)

  add_executable(ZToolsServiceManifestTest
    tests/manifest_test.cpp
    src/command_dispatcher.cpp
    src/command_policy.cpp
    src/privileged_dll_loader.cpp
    src/privileged_dll_task_manager.cpp
    src/privileged_dll_resolver.cpp
    src/privileged_manifest.cpp
    src/service_command_protocol.cpp
    src/service_auth.cpp
  )
  target_include_directories(ZToolsServiceManifestTest PRIVATE include)
  target_compile_definitions(ZToolsServiceManifestTest PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_compile_options(ZToolsServiceManifestTest PRIVATE /W4 /WX /utf-8 /sdl /guard:cf)
  target_link_options(ZToolsServiceManifestTest PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
  target_link_libraries(ZToolsServiceManifestTest PRIVATE advapi32 bcrypt shell32 shlwapi wtsapi32 xmllite)
  add_dependencies(ZToolsServiceManifestTest ZToolsServicePrivateConsumer ZToolsServiceSessionFixture)
  set(ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR
    "${CMAKE_BINARY_DIR}/service-manifest-test-win32-ia32")
  set_target_properties(
    ZToolsServicePrivateDependency
    ZToolsServicePrivateConsumer
    ZToolsServiceSessionFixture
    PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
      RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
      RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
      RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
  )
  set_target_properties(ZToolsServiceManifestTest PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${ZTOOLS_SERVICE_MANIFEST_TEST_OUTPUT_DIR}"
  )
endif()
