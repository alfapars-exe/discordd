import 'dart:convert';
import 'dart:js_interop';

@JS('hichatDeviceVault.acquire')
external JSPromise<JSNumber> _acquire(JSString scope);
@JS('hichatDeviceVault.load')
external JSPromise<JSString> _load(JSNumber handle);
@JS('hichatDeviceVault.save')
external JSPromise<JSString> _save(JSNumber handle, JSString value);
@JS('hichatDeviceVault.release')
external JSPromise<JSString> _release(JSNumber handle);

class DeviceStore {
  final int handle;
  DeviceStore._(this.handle);
  static Future<DeviceStore> open(String scope) async =>
      DeviceStore._((await _acquire(scope.toJS).toDart).toDartInt);
  Future<Map<String, dynamic>?> load() async =>
      jsonDecode((await _load(handle.toJS).toDart).toDart)
          as Map<String, dynamic>?;
  Future<void> save(Map<String, dynamic> value) async {
    await _save(handle.toJS, jsonEncode(value).toJS).toDart;
  }

  Future<void> close() async {
    await _release(handle.toJS).toDart;
  }
}
