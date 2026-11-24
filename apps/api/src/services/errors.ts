export class DecisionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionForbiddenError";
  }
}

export class DecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionConflictError";
  }
}

export class ProductConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductConflictError";
  }
}

export class ProductNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductNotFoundError";
  }
}

export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductValidationError";
  }
}

export class StockAlertNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAlertNotFoundError";
  }
}

export class StockAlertConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAlertConflictError";
  }
}

export class StockAlertValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAlertValidationError";
  }
}

export class BranchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchConflictError";
  }
}

export class BranchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchNotFoundError";
  }
}

export class BranchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchValidationError";
  }
}

export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderNotFoundError";
  }
}

export class OrderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderConflictError";
  }
}

export class OrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderValidationError";
  }
}
