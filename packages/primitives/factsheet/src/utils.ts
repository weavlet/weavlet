import type { ZodTypeAny } from "zod";

export const now = () => Date.now();

export const truncateValue = (value: unknown, maxLength: number): unknown => {
  if (typeof value === "string") {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
  return value;
};

export const cleanControlChars = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

export const allowsNull = (schema: ZodTypeAny): boolean => {
  const typeName = (schema as any)?._def?.typeName;
  if (!typeName) return false;
  if (typeName === "ZodNullable") return true;
  if (typeName === "ZodNull" || typeName === "ZodAny" || typeName === "ZodUnknown") return true;
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return allowsNull((schema as any)._def.innerType);
  }
  if (typeName === "ZodEffects") {
    // ZodEffects (from .refine(), .transform(), etc.) uses _def.schema, not _def.innerType
    return allowsNull((schema as any)._def.schema);
  }
  if (typeName === "ZodUnion") {
    const options = (schema as any)._def.options as ZodTypeAny[];
    return options.some((opt) => allowsNull(opt));
  }
  if (typeName === "ZodDiscriminatedUnion") {
    const options = Array.from((schema as any)._def.options.values()) as ZodTypeAny[];
    return options.some((opt) => allowsNull(opt));
  }
  return false;
};







