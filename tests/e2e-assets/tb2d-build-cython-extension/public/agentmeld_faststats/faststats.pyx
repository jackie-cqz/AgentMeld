import numpy as np
cimport numpy as cnp


def mean64(values):
    """Return the arithmetic mean using a compiled float64 NumPy buffer."""
    array = np.asarray(values, dtype=np.float)
    cdef cnp.ndarray[cnp.double_t, ndim=1] typed = array
    if typed.shape[0] == 0:
        raise ValueError("values must not be empty")
    return float(typed.mean())

