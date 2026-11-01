# Build a reviewed copy of one pinned SDK source; never edit the shared Pub cache.
if(NOT TARGET flutter_webrtc_plugin)
  message(FATAL_ERROR "flutter_webrtc plugin must be registered before capture patch")
endif()
get_target_property(_webrtc_windows flutter_webrtc_plugin SOURCE_DIR)
get_filename_component(_webrtc_root "${_webrtc_windows}/.." REALPATH)
set(_capture_source "${_webrtc_root}/common/cpp/src/flutter_screen_capture.cc")
file(SHA256 "${_capture_source}" _capture_sha)
if(NOT _capture_sha STREQUAL "5fd92ad57ea1b0464b8adcc2585b7b5fa044140bac4b905217b425c023b015d2")
  message(FATAL_ERROR "flutter_webrtc capture source changed: review Windows compatibility patch")
endif()
file(READ "${_capture_source}" _capture)
string(REPLACE "\r\n" "\n" _capture "${_capture}")
set(_old [=[  scoped_refptr<RTCDesktopCapturer> desktop_capturer =
      base_->desktop_device_->CreateDesktopCapturer(source, show_cursor);]=])
set(_new [=[  // Avoid Start(CS_FAILED) when Windows refuses focus from the capture thread.
  // WGC supports occluded windows and keeps the OS capture border/permission rules.
  RTCDesktopCapturerOptions capture_options;
  capture_options.show_cursor = show_cursor;
  capture_options.focus_window = false;
  capture_options.allow_wgc_window_capturer = true;
  scoped_refptr<RTCDesktopCapturer> desktop_capturer =
      base_->desktop_device_->CreateDesktopCapturerWithOptions(source, capture_options);]=])
string(FIND "${_capture}" "${_old}" _found)
if(_found LESS 0)
  message(FATAL_ERROR "Reviewed capture factory anchor missing")
endif()
string(REPLACE "${_old}" "${_new}" _capture "${_capture}")
set(_old [=[  desktop_capturer->Start(uint32_t(fps));]=])
set(_new [=[  if (desktop_capturer->Start(uint32_t(fps)) != RTCDesktopCapturer::CS_RUNNING) {
    desktop_capturer->Stop();
    stream->RemoveTrack(track);
    base_->local_tracks_.erase(uuid);
    base_->RemoveVideoSourceForId(uuid);
    base_->local_streams_.erase(uuid);
    result->Error("SCREEN_CAPTURE_START_FAILED", "Selected screen or window capture did not start");
    return;
  }]=])
string(FIND "${_capture}" "${_old}" _found)
if(_found LESS 0)
  message(FATAL_ERROR "Reviewed capture start anchor missing")
endif()
string(REPLACE "${_old}" "${_new}" _capture "${_capture}")
set(_patched "${CMAKE_CURRENT_BINARY_DIR}/hichat_patches/flutter_screen_capture.cc")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/hichat_patches")
file(WRITE "${_patched}" "${_capture}")
get_target_property(_sources flutter_webrtc_plugin SOURCES)
set(_filtered)
foreach(_source IN LISTS _sources)
  if(NOT _source MATCHES "(^|/)flutter_screen_capture\\.cc$")
    list(APPEND _filtered "${_source}")
  endif()
endforeach()
set_property(TARGET flutter_webrtc_plugin PROPERTY SOURCES "${_filtered}")
target_sources(flutter_webrtc_plugin PRIVATE "${_patched}")
install(FILES "${_webrtc_root}/LICENSE" DESTINATION "$<TARGET_FILE_DIR:${BINARY_NAME}>/data/licenses" RENAME "flutter-webrtc-LICENSE.txt" COMPONENT Runtime)
