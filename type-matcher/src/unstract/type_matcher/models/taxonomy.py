"""Shared semantic type taxonomy used by both value and field typing."""

from enum import Enum


class SemanticType(str, Enum):
    EMAIL = "EMAIL"
    PHONE = "PHONE"
    DATE = "DATE"
    NUMBER = "NUMBER"
    CURRENCY = "CURRENCY"
    PERCENTAGE = "PERCENTAGE"
    URL = "URL"
    BOOLEAN = "BOOLEAN"
    NAME_FIRST = "NAME_FIRST"
    NAME_MIDDLE = "NAME_MIDDLE"
    NAME_LAST = "NAME_LAST"
    NAME_FULL = "NAME_FULL"
    ADDRESS_LINE = "ADDRESS_LINE"
    ADDRESS_CITY = "ADDRESS_CITY"
    ADDRESS_STATE = "ADDRESS_STATE"
    ADDRESS_ZIP = "ADDRESS_ZIP"
    ADDRESS_COUNTRY = "ADDRESS_COUNTRY"
    SSN = "SSN"
    GENDER = "GENDER"
    COMPANY_NAME = "COMPANY_NAME"
    JOB_TITLE = "JOB_TITLE"
    ACCOUNT_NUMBER = "ACCOUNT_NUMBER"
    FREETEXT = "FREETEXT"
    ENUM_SELECT = "ENUM_SELECT"
    TEXT = "TEXT"


# Compatibility matrix: maps each type to set of types it can cross-match.
# Exact match is always allowed; this defines additional compatible pairs.
TYPE_COMPATIBILITY: dict[SemanticType, set[SemanticType]] = {
    SemanticType.NAME_FIRST: {SemanticType.NAME_FULL, SemanticType.TEXT},
    SemanticType.NAME_MIDDLE: {SemanticType.NAME_FULL, SemanticType.TEXT},
    SemanticType.NAME_LAST: {SemanticType.NAME_FULL, SemanticType.TEXT},
    SemanticType.NAME_FULL: {SemanticType.NAME_FIRST, SemanticType.NAME_MIDDLE, SemanticType.NAME_LAST, SemanticType.TEXT},
    SemanticType.GENDER: {SemanticType.ENUM_SELECT, SemanticType.TEXT},
    SemanticType.ADDRESS_LINE: {SemanticType.TEXT, SemanticType.FREETEXT},
    SemanticType.ADDRESS_CITY: {SemanticType.TEXT},
    SemanticType.ADDRESS_STATE: {SemanticType.TEXT, SemanticType.ENUM_SELECT},
    SemanticType.ADDRESS_COUNTRY: {SemanticType.TEXT, SemanticType.ENUM_SELECT},
    SemanticType.ADDRESS_ZIP: {SemanticType.TEXT, SemanticType.NUMBER},
    SemanticType.CURRENCY: {SemanticType.NUMBER, SemanticType.TEXT},
    SemanticType.PERCENTAGE: {SemanticType.NUMBER, SemanticType.TEXT},
    SemanticType.ACCOUNT_NUMBER: {SemanticType.TEXT, SemanticType.NUMBER},
    SemanticType.SSN: {SemanticType.TEXT},
    SemanticType.ENUM_SELECT: {SemanticType.TEXT},
    SemanticType.FREETEXT: {SemanticType.TEXT},
}


def types_compatible(a: SemanticType, b: SemanticType) -> bool:
    """Check whether two semantic types are compatible for matching."""
    if a == b:
        return True
    # TEXT is universally compatible (acts as wildcard)
    if a == SemanticType.TEXT or b == SemanticType.TEXT:
        return True
    return b in TYPE_COMPATIBILITY.get(a, set()) or a in TYPE_COMPATIBILITY.get(b, set())
