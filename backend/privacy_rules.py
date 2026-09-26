"""Defense-in-depth patterns for rejecting unsanitized extension payloads."""
import re


def _luhn(value):
    digits = re.sub(r"\D", "", value)
    if len(digits) < 2:
        return False
    total = 0
    double = False
    for char in reversed(digits):
        digit = int(char)
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double
    return total % 10 == 0


def _nhs_valid(value):
    digits = re.sub(r"\D", "", value)
    if len(digits) != 10:
        return False
    weighted_sum = sum(int(digit) * (10 - index) for index, digit in enumerate(digits[:9]))
    check = 11 - (weighted_sum % 11)
    return digits[-1] == ("0" if check == 11 else str(check)) and check != 10


def _iban_valid(value):
    normalized = re.sub(r"[\s-]", "", value).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", normalized):
        return False
    rearranged = normalized[4:] + normalized[:4]
    remainder = 0
    for char in rearranged:
        expanded = str(ord(char) - 55) if char.isalpha() else char
        for digit in expanded:
            remainder = (remainder * 10 + int(digit)) % 97
    return remainder == 1


def find_sensitive_category(text):
    """Return a category for a high-confidence sensitive pattern, else None."""
    if not isinstance(text, str) or not text:
        return None
    checks = [
        ("AADHAAR", re.compile(r"\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b")),
        ("PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", re.I)),
        ("SSN", re.compile(r"\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b")),
        ("NIN", re.compile(r"\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z]{2}\s?\d{6}\s?[A-D]\b", re.I)),
        ("EMAIL", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)),
        ("PHONE", re.compile(r"(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)")),
        ("PHONE", re.compile(r"(?<!\w)\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .-]?\d){6,12}(?!\w)")),
        ("DOB", re.compile(r"\b(?:0[1-9]|[12]\d|3[01])[-/.](?:0[1-9]|1[0-2])[-/.](?:19|20)\d{2}\b")),
        ("DOB", re.compile(r"\b(?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])[-/.](?:19|20)\d{2}\b")),
    ]
    for category, pattern in checks:
        if pattern.search(text):
            return category

    if re.search(r"\b(?:ssn|social\s+security(?:\s+number)?)\b", text, re.I):
        if re.search(r"\b(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}\b", text):
            return "SSN"

    if re.search(r"\b\d{3}[ -]?\d{3}[ -]?\d{3}\b", text) and re.search(r"\b(?:sin|social\s+insurance)\b", text, re.I):
        candidate = re.search(r"\b\d{3}[ -]?\d{3}[ -]?\d{3}\b", text).group(0)
        if _luhn(candidate):
            return "SIN"
    if re.search(r"\b\d{3}[ -]?\d{3}[ -]?\d{4}\b", text) and re.search(r"\bnhs\b", text, re.I):
        candidate = re.search(r"\b\d{3}[ -]?\d{3}[ -]?\d{4}\b", text).group(0)
        if _nhs_valid(candidate):
            return "NHS"
    iban = re.search(r"\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b", text, re.I)
    if iban and _iban_valid(iban.group(0)):
        return "IBAN"
    for match in re.finditer(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", text):
        if _luhn(match.group(0)):
            return "CREDIT_CARD"
    if re.search(r"\b[A-Z]{4}0[A-Z0-9]{6}\b", text, re.I):
        return "IFSC"
    return None
