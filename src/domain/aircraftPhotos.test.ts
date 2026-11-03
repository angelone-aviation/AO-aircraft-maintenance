/**
 * Responsibility: Pins the file types and size accepted for an aircraft photo.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/aircraftPhotos.ts.
 */
import { expect, it } from "vitest";
import { validateAircraftPhoto } from "./aircraftPhotos";

const FIVE_MIB = 5 * 1024 * 1024;
const TOO_LARGE = Error("Aircraft photos must be no larger than 5 MB.");

it.each(["image/jpeg", "image/png", "image/webp"])("accepts %s", (type) => {
  expect(() => validateAircraftPhoto(type, FIVE_MIB)).not.toThrow();
});

it("refuses other types before checking the size", () => {
  for (const type of ["image/gif", "image/heic", "", "IMAGE/JPEG"])
    expect(() => validateAircraftPhoto(type, 0)).toThrow(
      Error("Choose a JPEG, PNG or WebP aircraft photo."),
    );
});

it("accepts 1 byte to 5 MiB, in whole bytes", () => {
  expect(() => validateAircraftPhoto("image/png", 1)).not.toThrow();
  for (const size of [0, -1, 1.5, Number.NaN, FIVE_MIB + 1])
    expect(() => validateAircraftPhoto("image/png", size)).toThrow(TOO_LARGE);
});
