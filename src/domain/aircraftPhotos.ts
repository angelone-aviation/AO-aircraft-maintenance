export function validateAircraftPhoto(type: string, size: number) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(type))
    throw Error("Choose a JPEG, PNG or WebP aircraft photo.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > 5 * 1024 * 1024)
    throw Error("Aircraft photos must be no larger than 5 MB.");
}
