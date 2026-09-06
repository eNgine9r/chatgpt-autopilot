RANGED_READ_MAX_WINDOWS = 6
RANGED_READ_WINDOW_SECONDS = 900


def parse_ranged_read_target(target):
    parts = str(target or "").split(":", 4)
    if len(parts) != 5 or parts[1] != "lines":
        return None
    alias, _mode, start, count, path = parts
    if not alias or not path:
        return None
    try:
        start_i, count_i = int(start), int(count)
    except ValueError:
        return None
    return {"alias": alias, "path": path, "start": start_i, "count": count_i, "file_key": f"{alias}:{path}"}


def same_ranged_file(target, file_key):
    parsed = parse_ranged_read_target(target)
    return bool(parsed and parsed["file_key"] == str(file_key or ""))
