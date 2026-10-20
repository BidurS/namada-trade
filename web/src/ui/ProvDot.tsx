// ProvDot: the stamp for a secondary figure that needs its own provenance (path steps, the
// desktop rail, an exception row such as holder rank 1). No pill: dot, source word, age, mono
// 12 px with a dotted underline; 44 px hit area through ::after. Opens the provenance Sheet.
import { StampButton, type ProvControlProps } from './ProvChip';

export function ProvDot(props: ProvControlProps & { wrap?: boolean }) {
  const { wrap, className, ...rest } = props;
  return <StampButton {...rest} className={`${wrap ? 'pdot--wrap ' : ''}${className ?? ''}`} variant="pdot" />;
}

export default ProvDot;
