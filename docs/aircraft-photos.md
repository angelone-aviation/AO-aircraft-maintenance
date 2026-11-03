# Aircraft dashboard photos

Open **Aircraft → Edit aircraft → Dashboard photo** to upload, replace or remove a photo. For a new aircraft, save the aircraft first and then open Edit aircraft. Photo changes save immediately, independently of the aircraft details form.

JPEG, PNG and WebP images up to 5 MB are accepted. The browser decodes the image and converts it to a JPEG no larger than 1024 pixels on its longest edge. Dashboard cards display a cropped thumbnail; aircraft without a photo retain the aircraft illustration.

Photos are stored separately from aircraft operating records. Upload and removal require maintenance permission for the aircraft in the active Flight Program, including Flight Program administrators. Only aircraft visible in the reader's scoped snapshot receive photo URLs. Replacements and removals delete the previous stored file and write an audit event. The demo stores images only in the browser.

## Form 337 copies

Copies of FAA Form 337 (major repair and alteration) are kept on the aircraft record, one of the six status records of 14 CFR 91.417(a)(2)(vi) ([ADR-0004](adr/0004-logbook-generator-and-status-record-system.md)). Open **View aircraft** on the overview; the **Form 337 copies** section lists each copy with its upload date and size, and **Open** shows the file. Everyone who can read the aircraft sees the list, including pilots and aircraft owners in the owner portal.

With maintenance permission for the aircraft, **Upload Form 337 copy** stores a PDF, JPEG, PNG or WebP file up to 7 MB (the same checks as other record attachments) as soon as it is chosen; an aircraft holds up to 200 stored documents. **Delete** asks for confirmation and removes the copy. Uploads and deletions need a connection and write the audit events `aircraft.file_uploaded` and `aircraft.file_removed` with the file name, type and size. The aircraft's **Export status sheet** PDF lists the copies on file under **Form 337 copies**. Copies stay with the aircraft when it moves to another Flight Program. The demo stores copies only in the browser.
