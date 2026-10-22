import type * as React from 'react';

import { BUTTON_CLASS, cn } from '@/ui/base_components/classes';

function Button({ className, ...props }: React.ComponentProps<'button'>) {
	return (
		<button
			data-slot="button"
			className={cn(BUTTON_CLASS, className)}
			{...props}
		/>
	);
}

export { Button };
