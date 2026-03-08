# Third-party notices

This adapter was written from scratch for ioBroker, but the protocol knowledge and endpoint mapping were informed by these MIT-licensed community projects:

1. `americodias/duosida-ev`  
   Python library for direct TCP control of Duosida wallboxes. Used as a reference for:
   - the local TCP handshake
   - protobuf field numbers
   - UDP discovery ports / payload
   - command key names such as `VendorMaxWorkCurrent`

   Repository: https://github.com/americodias/duosida-ev  
   License: MIT

2. `jello1974/duosidaEV-home-assistant`  
   Home Assistant integration for the cloud-backed DS Charge variant. Used as a reference for:
   - X-Cheng cloud endpoints
   - request methods
   - selected configuration keys
   - high-level field names from cloud responses

   Repository: https://github.com/jello1974/duosidaEV-home-assistant  
   License: MIT

No vendor SDK or vendor source code is included in this repository.
